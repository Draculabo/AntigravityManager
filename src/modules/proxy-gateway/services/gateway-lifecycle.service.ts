import { ConfigManager } from '@/modules/config/ipc/manager';
import type { ProxyConfig } from '@/modules/config/types';
import { bootstrapNestServer, stopNestServer, type NestServerStartResult } from '@/server/main';
import { logger } from '@/shared/logging/logger';

interface GatewayLifecycleDependencies {
  loadConfig(): ProxyConfig;
  start(config: ProxyConfig): Promise<NestServerStartResult>;
  stop(): Promise<boolean>;
}

const defaultDependencies: GatewayLifecycleDependencies = {
  loadConfig: () => ConfigManager.loadConfig().proxy,
  start: bootstrapNestServer,
  stop: stopNestServer,
};

/** Serializes gateway mutations in either the embedded host or standalone core. */
export class GatewayLifecycleService {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: GatewayLifecycleDependencies = defaultDependencies) {}

  start(port: number): Promise<NestServerStartResult> {
    return this.enqueue(() => {
      const config = this.dependencies.loadConfig();
      return this.startInternal({ ...config, port });
    });
  }

  startConfigured(config: ProxyConfig): Promise<NestServerStartResult> {
    return this.enqueue(() => this.startInternal(config));
  }

  stop(): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        return await this.dependencies.stop();
      } catch (error) {
        logger.error('Failed to stop gateway:', error);
        return false;
      }
    });
  }

  private async startInternal(config: ProxyConfig): Promise<NestServerStartResult> {
    try {
      const stopped = await this.dependencies.stop();
      if (!stopped) {
        throw new Error('Failed to stop gateway before restart');
      }
      return await this.dependencies.start(config);
    } catch (error) {
      logger.error('Failed to start gateway:', error);
      return {
        success: false,
        reason: 'unknown',
        port: config.port,
        message: error instanceof Error ? error.message : 'Failed to start gateway',
      };
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const gatewayLifecycleService = new GatewayLifecycleService();
