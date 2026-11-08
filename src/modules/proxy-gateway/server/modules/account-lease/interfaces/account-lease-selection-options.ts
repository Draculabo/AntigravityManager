import type { AccountLeaseSelectionWait } from '../policies/account-lease-selection-wait';

/** Shared by ordinary selection and all attempts in one image queue operation. */
export interface AccountLeaseSelectionOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
  /** The model is already a resolved physical route, even when its ID is also a public preset. */
  physicalTarget?: boolean;
  targetAccountId?: string;
  effort?: string;
  allowSelectionWait?: boolean;
  signal?: AbortSignal;
  selectionDeadlineMs?: number;
  selectionWaitBudget?: AccountLeaseSelectionWait;
  quotaRecoveryAllowance?: { used: boolean };
}
