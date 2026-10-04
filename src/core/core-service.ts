import { ConfigManager } from '@/modules/config/ipc/manager';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { initDatabase } from '@/modules/account/public';
import { getNestServerStatus, type NestServerStartResult } from '@/server/main';
import { gatewayLifecycleService } from '@/modules/proxy-gateway/services/gateway-lifecycle.service';
import { logger } from '@/shared/logging/logger';
import type { AppConfig } from '@/modules/config/types';

export type CoreState = 'stopped' | 'starting' | 'running' | 'stopping';

export interface CoreStatus {
  state: CoreState;
  pid: number;
  gateway: { running: boolean; port: number | null };
}

export interface CoreDependencies {
  enableFileLogging(): void;
  loadConfig(): AppConfig;
  initializeAccounts(): Promise<void>;
  initializeLocalDatabase(): void;
  startGateway(config: AppConfig['proxy']): Promise<NestServerStartResult>;
  startGatewayOnPort(port: number): Promise<NestServerStartResult>;
  stopGateway(): Promise<boolean>;
  getGatewayStatus(): ReturnType<typeof getNestServerStatus>;
}

const defaultDependencies: CoreDependencies = {
  enableFileLogging: () => logger.enableFileLogging(undefined, 'core'),
  loadConfig: () => ConfigManager.loadConfig(),
  initializeAccounts: () => CloudAccountRepo.init(),
  initializeLocalDatabase: () => initDatabase(),
  startGateway: (config) => gatewayLifecycleService.startConfigured(config),
  startGatewayOnPort: (port) => gatewayLifecycleService.start(port),
  stopGateway: () => gatewayLifecycleService.stop(),
  getGatewayStatus: () => getNestServerStatus(),
};

export class CoreService {
  private state: CoreState = 'stopped';
  private gatewayPort: number | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private gatewayQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: CoreDependencies = defaultDependencies) {}

  getStatus(): CoreStatus {
    return {
      state: this.state,
      pid: process.pid,
      gateway: { running: this.gatewayPort !== null, port: this.gatewayPort },
    };
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error('Core service is already starting or running');
    }

    this.state = 'starting';
    const startup = this.startInternal();
    this.startPromise = startup;
    try {
      await startup;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    try {
      this.dependencies.enableFileLogging();
      const config = this.dependencies.loadConfig();
      await this.dependencies.initializeAccounts();
      this.dependencies.initializeLocalDatabase();

      if (config.proxy.auto_start) {
        const result = await this.dependencies.startGateway(config.proxy);
        if (!result.success) {
          throw new Error(`Gateway startup failed: ${result.message}`);
        }
        this.gatewayPort = result.port;
      }

      this.state = 'running';
    } catch (error) {
      try {
        await this.dependencies.stopGateway();
      } catch {
        // Preserve the startup error, which identifies the failed operation.
      }
      this.gatewayPort = null;
      this.state = 'stopped';
      throw error;
    }
  }

  startGateway(port: number): Promise<NestServerStartResult> {
    return this.enqueueGatewayMutation(async () => {
      this.requireRunning();
      const result = await this.dependencies.startGatewayOnPort(port);
      await this.refreshGatewayStatus();
      return result;
    });
  }

  stopGateway(): Promise<boolean> {
    return this.enqueueGatewayMutation(async () => {
      this.requireRunning();
      const stopped = await this.dependencies.stopGateway();
      await this.refreshGatewayStatus();
      return stopped;
    });
  }

  private requireRunning(): void {
    if (this.state !== 'running') {
      throw new Error('Core service is not running');
    }
  }

  private async refreshGatewayStatus(): Promise<void> {
    const status = await this.dependencies.getGatewayStatus();
    this.gatewayPort = status.running ? status.port : null;
  }

  private enqueueGatewayMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gatewayQueue.then(operation);
    this.gatewayQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (this.state === 'stopped') {
      return;
    }

    const startup = this.startPromise;
    const shutdown = (async () => {
      if (startup) {
        try {
          await startup;
        } catch {
          // Startup already performed its own rollback.
          return;
        }
      }
      if (this.state === 'stopped') {
        return;
      }

      this.state = 'stopping';
      try {
        await this.gatewayQueue;
        const stopped = await this.dependencies.stopGateway();
        if (!stopped) {
          throw new Error('Gateway shutdown failed');
        }
      } finally {
        this.gatewayPort = null;
        this.state = 'stopped';
      }
    })();
    this.stopPromise = shutdown;
    try {
      await shutdown;
    } finally {
      this.stopPromise = null;
    }
  }
}
