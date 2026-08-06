import { getServerConfig } from '../../../../../../server/server-config';
import {
  type AccountLeaseSelectionConfig,
  type AccountLeaseSelectionMode,
} from './account-lease-selection-policy';
import { normalizeProjectId } from '../interfaces/account-lease-token-types';

const DEFAULT_FALLBACK_PROJECT_ID = 'silver-orbit-5m7qc';
const DEFAULT_BACKOFF_STEPS = [60, 300, 1800, 7200];

export class AccountLeaseConfigPolicy {
  getSelectionConfig(): AccountLeaseSelectionConfig {
    const config = getServerConfig();
    return {
      parityEnabled: Boolean(config?.parity_enabled) && !config?.parity_kill_switch,
      parityShadowEnabled: Boolean(config?.parity_shadow_enabled),
      schedulingMode: this.getSchedulingMode(),
      preferredAccountId: this.getPreferredAccountId(),
      maxWaitMs: this.getMaxWaitDurationMs(),
      noGoMismatchRateThreshold: this.getNoGoMismatchRateThreshold(),
      noGoErrorRateThreshold: this.getNoGoErrorRateThreshold(),
    };
  }

  setPreferredAccount(accountId?: string): void {
    const config = getServerConfig();
    if (!config) {
      return;
    }
    config.preferred_account_id = accountId ?? '';
  }

  getCircuitBreakerBackoffSteps(): number[] {
    const config = getServerConfig();
    const configured = config?.circuit_breaker_backoff_steps ?? DEFAULT_BACKOFF_STEPS;
    const normalized = configured
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.ceil(value));
    if (normalized.length > 0) {
      return normalized;
    }
    return DEFAULT_BACKOFF_STEPS;
  }

  resolveFallbackProjectId(): string {
    const fromEnv = process.env.PROXY_FALLBACK_PROJECT_ID?.trim();
    const normalizedFromEnv = normalizeProjectId(fromEnv);
    if (normalizedFromEnv) {
      return normalizedFromEnv;
    }
    return DEFAULT_FALLBACK_PROJECT_ID;
  }

  private getSchedulingMode(): AccountLeaseSelectionMode {
    const config = getServerConfig();
    const mode = (config?.scheduling_mode ?? 'balance').toLowerCase();
    if (mode === 'cache-first' || mode === 'performance-first' || mode === 'balance') {
      return mode;
    }
    return 'balance';
  }

  private getMaxWaitDurationMs(): number {
    const config = getServerConfig();
    const seconds = config?.max_wait_seconds ?? 60;
    return Math.max(0, seconds) * 1000;
  }

  private getPreferredAccountId(): string | undefined {
    const config = getServerConfig();
    const preferred = config?.preferred_account_id?.trim();
    return preferred ? preferred : undefined;
  }

  private getNoGoMismatchRateThreshold(): number {
    const config = getServerConfig();
    const threshold = config?.parity_no_go_mismatch_rate ?? 0.15;
    if (!Number.isFinite(threshold)) {
      return 0.15;
    }
    return Math.min(1, Math.max(0, threshold));
  }

  private getNoGoErrorRateThreshold(): number {
    const config = getServerConfig();
    const threshold = config?.parity_no_go_error_rate ?? 0.4;
    if (!Number.isFinite(threshold)) {
      return 0.4;
    }
    return Math.min(1, Math.max(0, threshold));
  }
}
