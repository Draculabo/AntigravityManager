import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { configureElectronSecurityRuntime } from '@/shared/security/electron-security-runtime';

/** Configure desktop key providers only for one-time conversion of old encrypted rows. */
export async function initializeDesktopAccountSecurity(): Promise<void> {
  configureElectronSecurityRuntime();
  await CloudAccountRepo.init();
}
