import { CloudAccountRepo, type CloudAccountWriteGuard } from '../persistence/cloudHandler';
import { isEqual, isUndefined, omitBy } from 'lodash-es';
import type { CloudAccount, CloudTokenData } from '../types';
import type { CloudAccountQuotaObservation } from './cloud-account-quota-observation';
import {
  captureRefreshContext,
  CloudAccountRefreshContextChangedError,
} from './cloud-account-refresh-context';

/** Whole-token replacement must not discard concurrently discovered project/session metadata. */
export function captureTokenWriteGuard(account: CloudAccount): CloudAccountWriteGuard {
  const context = captureRefreshContext(account);
  // JSON persistence omits undefined optional fields; they do not identify a new token context.
  const token = omitBy(account.token, isUndefined);
  return (current) => {
    context.assertCurrent(current);
    if (!isEqual(current && omitBy(current.token, isUndefined), token)) {
      throw new CloudAccountRefreshContextChangedError(account.id);
    }
  };
}

/** A refresh owns one stored identity/grant/access-token context, advancing only after its write. */
export class CloudAccountRefreshWriteback {
  private context: ReturnType<typeof captureRefreshContext>;
  private accessToken: string;

  constructor(
    private readonly account: CloudAccount,
    private readonly observation?: CloudAccountQuotaObservation,
  ) {
    this.context = captureRefreshContext(account);
    this.accessToken = account.token.access_token;
  }

  readonly guard: CloudAccountWriteGuard = (current) => this.assertAccount(current);

  guardFor(cause: unknown): CloudAccountWriteGuard {
    return (current) => this.assertAccount(current, cause);
  }

  async assertCurrent(cause?: unknown): Promise<void> {
    this.assertAccount(await CloudAccountRepo.getAccount(this.account.id), cause);
  }

  async updateToken(token: CloudTokenData): Promise<void> {
    if (
      !(await CloudAccountRepo.compareAndUpdateToken(
        this.account.id,
        this.account.token,
        token,
        this.guard,
        true,
      ))
    ) {
      throw new CloudAccountRefreshContextChangedError(this.account.id);
    }
    this.account.token = token;
    this.context = captureRefreshContext(this.account);
    this.accessToken = token.access_token;
    await this.assertCurrent();
  }

  private assertAccount(current: CloudAccount | undefined, cause?: unknown): void {
    this.observation?.assertCurrent(cause);
    this.context.assertCurrent(current, cause);
    if (current?.token.access_token !== this.accessToken) {
      throw new CloudAccountRefreshContextChangedError(this.account.id, { cause });
    }
  }
}
