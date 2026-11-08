import { isEqual } from 'lodash-es';
import { CloudAccountRepo, type CloudAccountWriteGuard } from '../persistence/cloudHandler';
import type { CloudAccount, CloudTokenData } from '../types';
import { captureTokenWriteGuard } from './cloud-account-refresh-writeback';
import { CloudAccountRefreshContextChangedError } from './cloud-account-refresh-context';
import { GoogleAPIService } from './GoogleAPIService';
import { logger } from '@/shared/logging/logger';
import { ENTERPRISE_OAUTH_CLIENT_KEY } from './cloud-account-oauth-settings.service';

/** Owns the exact credentials and bound profile prepared for one official-client switch. */
export class CloudAccountSwitchContext {
  private expected: CloudAccountWriteGuard;

  constructor(private readonly account: CloudAccount) {
    this.expected = this.capture();
  }

  readonly guard: CloudAccountWriteGuard = (current) => this.expected(current);

  guardFor(cause: unknown): CloudAccountWriteGuard {
    return (current) => {
      try {
        this.guard(current);
      } catch (error) {
        if (error instanceof CloudAccountRefreshContextChangedError) {
          throw new CloudAccountRefreshContextChangedError(this.account.id, { cause });
        }
        throw error;
      }
    };
  }

  readonly assertCurrent = async (cause?: unknown): Promise<void> => {
    this.guardFor(cause)(await CloudAccountRepo.getAccount(this.account.id));
  };

  async updateToken(token: CloudTokenData): Promise<void> {
    await this.assertCurrent();
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
    this.expected = this.capture();
    await this.assertCurrent();
  }

  /** Called synchronously after this switch's own initial binding, without an intervening await. */
  acceptOwnProfile(): void {
    this.expected = this.capture();
  }

  private capture(): CloudAccountWriteGuard {
    const tokenGuard = captureTokenWriteGuard(this.account);
    const profile = structuredClone(this.account.device_profile);
    return (current) => {
      tokenGuard(current);
      if (!isEqual(current?.device_profile, profile)) {
        throw new CloudAccountRefreshContextChangedError(this.account.id);
      }
    };
  }
}

export async function ensureCloudSwitchProjectReady(
  account: CloudAccount,
  context: CloudAccountSwitchContext,
): Promise<void> {
  if (
    account.token.oauth_client_key?.trim().toLowerCase() !== ENTERPRISE_OAUTH_CLIENT_KEY ||
    account.token.project_id?.trim()
  ) {
    return;
  }
  await context.assertCurrent();
  let project: string | null;
  try {
    project = await GoogleAPIService.fetchProjectId(account.token.access_token, account.proxy_url);
  } catch (error) {
    if (error instanceof CloudAccountRefreshContextChangedError) {
      throw error;
    }
    await context.assertCurrent(error);
    logger.warn(
      'Enterprise project discovery failed; continuing switch without a discovered project',
      error,
    );
    return;
  }
  await context.assertCurrent();
  if (project?.trim()) {
    await context.updateToken({ ...account.token, project_id: project.trim() });
  } else {
    logger.warn(
      'Enterprise project is unavailable; continuing switch without a discovered project',
    );
  }
}
