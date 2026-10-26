import type { AccountLeaseSelectionWait } from '../policies/account-lease-selection-wait';

/** Shared by ordinary selection and all attempts in one image queue operation. */
export interface AccountLeaseSelectionOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
  targetAccountId?: string;
  effort?: string;
  allowSelectionWait?: boolean;
  signal?: AbortSignal;
  selectionDeadlineMs?: number;
  selectionWaitBudget?: AccountLeaseSelectionWait;
  quotaRecoveryAllowance?: { used: boolean };
}
