import {
  isExhaustedQuotaWindow,
  modelQuotaWindows,
} from '@/modules/cloud-account/utils/quota-windows';
import type { CloudQuotaData } from '@/modules/cloud-account/types';
import type { AccountLeaseTokenData } from '../interfaces/account-lease-token-types';
import type { AccountLeaseSelectionWait } from './account-lease-selection-wait';
import type { AccountLeaseQuotaRefreshOutcome } from './account-lease-quota-refresh.policy';

/** An expired snapshot requires evidence; it is not permission to generate or invent a new cycle. */
export function needsQuotaWindowRefresh(
  quota: CloudQuotaData | undefined,
  model: string,
  now = Date.now(),
): boolean {
  const depleted = modelQuotaWindows(quota, model).filter(isExhaustedQuotaWindow);
  return depleted.length > 0 && depleted.every((bucket) => Date.parse(bucket.reset_time) <= now);
}

interface RecoveryOptions {
  getCandidates: (
    model: string,
    excluded: readonly string[],
    effort?: string,
    physicalTarget?: boolean,
  ) => Array<[string, AccountLeaseTokenData]>;
  getCurrent: (id: string) => AccountLeaseTokenData | undefined;
  physicalModel: (id: string, model: string, effort?: string, physicalTarget?: boolean) => string;
  isAvailable: (
    id: string,
    token: AccountLeaseTokenData,
    model: string,
    effort?: string,
    physicalTarget?: boolean,
  ) => boolean;
  refresh: (
    id: string,
    model: string,
    signal: AbortSignal,
    deadlineMs: number,
    effort?: string,
  ) => Promise<AccountLeaseQuotaRefreshOutcome>;
}

interface ProbeState {
  busy: boolean;
  attemptedAt: number;
  controller?: AbortController;
}

/** One account per selection; no waiting queue and no generation/OAuth replay. */
export class AccountLeaseQuotaRecoveryPolicy {
  private readonly states = new WeakMap<AccountLeaseTokenData, ProbeState>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly options: RecoveryOptions) {}

  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers) {
      controller.abort(new Error('Quota recovery owner stopped'));
    }
  }

  cancel(token: AccountLeaseTokenData | undefined): void {
    if (token) {
      this.states.get(token)?.controller?.abort(new Error('Quota recovery account invalidated'));
    }
  }

  async prepare(request: {
    model?: string;
    effort?: string;
    physicalTarget?: boolean;
    excluded: readonly string[];
    waitBudget: AccountLeaseSelectionWait;
    signal?: AbortSignal;
    allowance?: { used: boolean };
  }): Promise<void> {
    const { model, effort, signal, physicalTarget } = request;
    const budget = Math.min(2000, request.waitBudget.remainingMs());
    if (!model || this.stopped || signal?.aborted || budget <= 0 || request.allowance?.used) {
      return;
    }
    const now = Date.now();
    const candidates = this.options.getCandidates(model, request.excluded, effort, physicalTarget);
    const needsRefresh = (id: string, token: AccountLeaseTokenData) =>
      needsQuotaWindowRefresh(
        token.quota,
        this.options.physicalModel(id, model, effort, physicalTarget),
        now,
      );
    if (
      candidates.some(
        ([id, token]) =>
          !needsRefresh(id, token) && this.options.isAvailable(id, token, model, effort, physicalTarget),
      )
    ) {
      return;
    }
    const candidate = candidates
      .filter(
        ([id, token]) =>
          needsRefresh(id, token) && this.options.isAvailable(id, token, model, effort, physicalTarget),
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .find(([, token]) => {
        const state = this.states.get(token);
        return !state || (!state.busy && now - state.attemptedAt >= 30_000);
      });
    if (!candidate) {
      return;
    }
    const [id, token] = candidate;
    if (request.allowance) {
      request.allowance.used = true;
    }
    const state: ProbeState = { busy: true, attemptedAt: now };
    this.states.set(token, state);
    const controller = new AbortController();
    state.controller = controller;
    const deadlineMs = now + budget;
    this.controllers.add(controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const timer = setTimeout(
      () => controller.abort(new Error('Quota recovery deadline exceeded')),
      budget,
    );
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) {
        resolve();
      }
    });
    const operation = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted || Date.now() >= deadlineMs) {
          return;
        }
        const outcome = await this.options.refresh(
          id,
          this.options.physicalModel(id, model, effort, physicalTarget),
          controller.signal,
          deadlineMs,
          effort,
        );
        const current = this.options.getCurrent(id);
        if (!controller.signal.aborted && outcome !== 'stale' && current) {
          this.states.set(current, state);
        }
      } finally {
        // Keep a non-cooperative adapter single-flight even after its caller times out.
        state.busy = false;
      }
    });
    try {
      await Promise.race([operation, cancelled]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (onAbort) {
        controller.signal.removeEventListener('abort', onAbort);
      }
      this.controllers.delete(controller);
    }
  }
}
