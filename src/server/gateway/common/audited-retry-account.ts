import type { CloudAccount } from '@/modules/cloud-account/types';
import { setCurrentAuditAccountId } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import type {
  ProxyRetryService,
  ProxyTokenRetryState,
} from '../shared/services/proxy-retry.service';
import { throwIfRequestAborted } from './request-cancellation';

export interface RetryAccountSelection {
  model: string;
  sessionKey?: string;
  imageRequest: boolean;
  signal?: AbortSignal;
  effort?: string;
  targetAccountId?: string;
}

export async function selectAuditedRetryAccount(
  retryPolicy: ProxyRetryService,
  retryState: ProxyTokenRetryState,
  { model, sessionKey, imageRequest, signal, effort, targetAccountId }: RetryAccountSelection,
): Promise<CloudAccount | null> {
  const account = await retryPolicy.selectRetryToken(
    retryState,
    model,
    sessionKey,
    imageRequest,
    signal,
    effort,
    targetAccountId,
  );
  throwIfRequestAborted(signal);
  setCurrentAuditAccountId(
    account?.id ?? null,
    account?.email ?? null,
    account?.lifecycle_generation,
    account?.google_usage_subject_hash,
    account?.google_usage_grant_hash,
  );
  return account;
}
