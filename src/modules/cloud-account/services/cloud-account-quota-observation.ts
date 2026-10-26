import { CloudAccountRefreshContextChangedError } from './cloud-account-refresh-context';

interface ObservationState {
  issued: number;
  accepted: number;
  active: number;
}

/** All quota writers in the profile owner share one ordering fence per account. */
export class CloudAccountQuotaObservation {
  private static readonly accounts = new Map<string, ObservationState>();
  private readonly state: ObservationState;
  private readonly ticket: number;
  private closed = false;

  constructor(private readonly accountId: string) {
    this.state = CloudAccountQuotaObservation.accounts.get(accountId) ?? {
      issued: 0,
      accepted: 0,
      active: 0,
    };
    CloudAccountQuotaObservation.accounts.set(accountId, this.state);
    this.ticket = ++this.state.issued;
    this.state.active += 1;
  }

  isCurrent(): boolean {
    return !this.closed && this.ticket >= this.state.accepted;
  }

  assertCurrent(cause?: unknown): void {
    if (!this.isCurrent()) {
      throw new CloudAccountRefreshContextChangedError(this.accountId, { cause });
    }
  }

  /** Accept only after validating the stored identity; issuance alone supersedes nothing. */
  accept(cause?: unknown): void {
    this.assertCurrent(cause);
    this.state.accepted = this.ticket;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state.active -= 1;
    // Keep a newer completed result's watermark while any older owner can still resume.
    if (this.state.active === 0) {
      CloudAccountQuotaObservation.accounts.delete(this.accountId);
    }
  }
}
