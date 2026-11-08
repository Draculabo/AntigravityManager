import { ConfigManager } from '@/modules/config/ipc/manager';
import type { ProxyConfig } from '@/modules/config/types';
import { bootstrapNestServer, stopNestServer, type NestServerStartResult } from '@/server/main';
import { logger } from '@/shared/logging/logger';
import { randomUUID } from 'node:crypto';
import { serviceConfigService } from '@/modules/config/service-config.service';
import type {
  GatewayRememberChoice,
  GatewayChoicePersistence,
  GatewayManualStartResult,
  GatewayManualStopResult,
} from './gateway-management.schema';

interface GatewayLifecycleDependencies {
  loadConfig(): ProxyConfig;
  start(config: ProxyConfig): Promise<NestServerStartResult>;
  stop(): Promise<boolean>;
  rememberChoice?(choice: GatewayRememberChoice): Promise<void>;
}

const defaultDependencies: GatewayLifecycleDependencies = {
  loadConfig: () => ConfigManager.loadConfig().proxy,
  start: bootstrapNestServer,
  stop: stopNestServer,
  rememberChoice: async (choice) => {
    await serviceConfigService.update({
      proxy: {
        enabled: choice.enabled,
        auto_start: choice.enabled,
        ...(choice.port === undefined ? {} : { port: choice.port }),
      },
    });
  },
};

/** Serializes gateway mutations in either the embedded host or standalone core. */
export class GatewayLifecycleService {
  private queue: Promise<void> = Promise.resolve();
  private accepting = true;
  private pending = 0;

  constructor(private readonly dependencies: GatewayLifecycleDependencies = defaultDependencies) {}

  closeAdmission(): void {
    this.accepting = false;
  }

  drain(): Promise<void> {
    return this.queue;
  }

  manualStart(port: number): Promise<GatewayManualStartResult> {
    return this.enqueue(async () => {
      const config = this.dependencies.loadConfig();
      const started = await this.startInternal({ ...config, port });
      const operation = started.success ? started : {
        ...started,
        message: started.reason === 'address-in-use'
          ? `Port ${started.port} is already in use.`
          : 'The gateway could not be started.',
      };
      const persistence = operation.success
        ? await this.persistChoice({ enabled: true, port: operation.port })
        : { state: 'not-attempted' as const };
      return { operation, persistence };
    });
  }

  manualStop(): Promise<GatewayManualStopResult> {
    return this.enqueue(async () => {
      let success = false;
      try {
        success = await this.dependencies.stop();
      } catch (error) {
        logger.error('Manual gateway stop failed.', error);
      }
      const persistence = success
        ? await this.persistChoice({ enabled: false })
        : { state: 'not-attempted' as const };
      return { success, persistence };
    });
  }

  retrySaveChoice(choice: GatewayRememberChoice): Promise<GatewayChoicePersistence> {
    return this.enqueue(() => this.persistChoice(choice));
  }

  private async persistChoice(choice: GatewayRememberChoice): Promise<GatewayChoicePersistence> {
    try {
      if (!this.dependencies.rememberChoice) {
        throw new Error('The gateway owner cannot persist a startup choice.');
      }
      await this.dependencies.rememberChoice(choice);
      return { state: 'saved' };
    } catch (error) {
      const diagnosticId = randomUUID();
      logger.error('Gateway operation completed; startup choice could not be saved.', { diagnosticId }, error);
      return { state: 'failed', choice, diagnosticId };
    }
  }

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
    }, true);
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

  private enqueue<T>(operation: () => Promise<T>, cleanup = false): Promise<T> {
    if (!this.accepting && !cleanup) {
      return Promise.reject(new Error('Gateway operations are shutting down.'));
    }
    // Match the settings owner's 32-message control-plane admission budget.
    if (this.pending >= 32 && !cleanup) {
      return Promise.reject(new Error('The gateway operation queue is full.'));
    }
    this.pending += 1;
    const result = this.queue.then(operation).finally(() => {
      this.pending -= 1;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const gatewayLifecycleService = new GatewayLifecycleService();
