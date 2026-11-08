import path from 'node:path';
import { logger } from '@/shared/logging/logger';
import { getAgentDir } from '@/shared/platform/paths';
import { resolveErrorWindowBudget, type ErrorWindowBudget } from './error-budget';
import type { ErrorDiagnosticsConfig } from './error-settings';
import type { ErrorDiagnosticRole } from './error-window.database';
import { ErrorWindowService } from './error-window.service';
import type { CreateDiagnosticErrorRecordInput } from '@/shared/observability/errorDiagnostic';

/** Selected process owns one role; Nest stop/start never replaces this writer. */
class ErrorProcessOwner {
  private service: ErrorWindowService | null = null;
  private role: ErrorDiagnosticRole | null = null;
  private closed = false;
  private appliedBytes: number | null = null;
  get activeRole(): ErrorDiagnosticRole | null {
    return this.role;
  }

  register(role: ErrorDiagnosticRole): void {
    if (this.closed || (this.role !== null && this.role !== role)) {
      throw new Error('Local error diagnostic process ownership is unavailable');
    }
    this.role = role;
    this.service ??= new ErrorWindowService({
      role,
      databasePath: path.join(getAgentDir(), 'error-diagnostics', `${role}.errors.db`),
      workerPath: path.join(__dirname, 'error-window.worker.js'),
    });
    this.service.attachLogger(logger);
  }

  async start(
    role: ErrorDiagnosticRole,
    config: ErrorDiagnosticsConfig,
    budget?: ErrorWindowBudget,
  ): Promise<void> {
    this.register(role);
    if (budget) {
      await this.applyBudget(budget);
    } else {
      await this.configure(config);
    }
  }

  async configure(config: ErrorDiagnosticsConfig): Promise<void> {
    await this.applyBudget(
      resolveErrorWindowBudget(config.max_storage_mib, process.env.AGM_INTERNAL_ERROR_LOG_MB),
    );
  }

  async applyBudget(budget: ErrorWindowBudget): Promise<void> {
    if (this.closed) {
      throw new Error('Local error diagnostic process owner is closed');
    }
    if (this.service && this.role) {
      const allocation = this.role === 'app' ? budget.appBytes : budget.coreBytes;
      if (allocation !== this.appliedBytes || !this.service.storageReady) {
        await this.service.applyAllocation(allocation);
        this.appliedBytes = allocation;
      }
    }
  }

  get(): ErrorWindowService {
    if (!this.service || this.closed) {
      throw new Error('Local error diagnostic process owner is unavailable');
    }
    return this.service;
  }

  capture(input: CreateDiagnosticErrorRecordInput): void {
    this.service?.capture(input);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.service?.shutdown();
  }
}

export const errorProcessOwner = new ErrorProcessOwner();
