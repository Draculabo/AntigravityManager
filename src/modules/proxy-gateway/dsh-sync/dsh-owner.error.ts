export type DshErrorCode = 'unavailable' | 'home-missing' | 'read-failed' | 'invalid-config' | 'conflict' | 'write-failed' | 'receipt-failed';
export class DshOwnerError extends Error {
  constructor(readonly code: DshErrorCode, cause?: unknown) {
    super(`DSH configuration operation ${code}`, { cause });
    this.name = 'DshOwnerError';
  }
}
