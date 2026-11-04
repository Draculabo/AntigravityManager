export { CoreRpcClient } from '@/core/rpc/client';
export { getManagementEndpoint } from '@/core/management/endpoint';
export {
  readWindowsCredential,
  readWindowsCredentialSnapshot,
  writeWindowsCredential,
} from '@/modules/antigravity-runtime/credentials/windowsCredentialStore';
export { readClientAccountToken } from '@/modules/antigravity-runtime';
export { resolveClientAccountStorage } from '@/modules/antigravity-runtime/credentials/clientAccountWrite';
export { ProtobufUtils } from '@/shared/serialization/protobuf';
export { convertEncryptedAccountFields } from '@/modules/cloud-account/persistence/convert-encrypted-account-fields';
export {
  configureSecurityRuntime,
  createKeytarProviders,
  decrypt,
} from '@/shared/security/security';
export { DesktopPreferencesSchema } from '@/modules/config/service-config.schema';
export { prepareLaunchContext } from '@/modules/antigravity-runtime/launchContext';
export { stopFromContext } from '@/modules/antigravity-runtime/stop';
export { startFromContext } from '@/modules/antigravity-runtime/launch';
export { confirmIdeAccountIdentity } from '@/modules/antigravity-runtime/ideAccountIdentity';
export { restoreWindowsIdeCredentials } from '@/modules/antigravity-runtime/credentials/windowsIdeRecovery';
export {
  prepareLinuxIdeRecovery,
  restoreLinuxIdeCredentials,
} from '@/modules/antigravity-runtime/credentials/linuxIdeRecovery';
export {
  readLinuxIdeCredentialSnapshot,
  restoreLinuxIdeCredentialSnapshot,
  writeLinuxIdeCredentialPayload,
} from '@/modules/antigravity-runtime/credentials/linuxIdeCredentialStore';
