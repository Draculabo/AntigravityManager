import { isEqual } from 'lodash-es';
import type { CloudAccountWriteGuard } from '../persistence/cloudHandler';
import type { CloudAccount } from '../types';
import { captureTokenWriteGuard } from './cloud-account-refresh-writeback';
import { CloudAccountRefreshContextChangedError } from './cloud-account-refresh-context';

/** Binding owns the observed account, profile and history; an unchanged ID is insufficient. */
export function captureDeviceBindingWriteGuard(account: CloudAccount): CloudAccountWriteGuard {
  const tokenGuard = captureTokenWriteGuard(account);
  const profile = structuredClone(account.device_profile);
  const history = structuredClone(account.device_history ?? []);
  return (current) => {
    tokenGuard(current);
    if (
      !isEqual(current?.device_profile, profile) ||
      !isEqual(current?.device_history ?? [], history)
    ) {
      throw new CloudAccountRefreshContextChangedError(account.id);
    }
  };
}
