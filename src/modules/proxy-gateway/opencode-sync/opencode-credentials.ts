import { OpenCodeCredentialService } from './opencode-credential.service';
import { OpenCodeNativeCredentialStore } from './opencode-native-credential-store';

export const openCodeCredentialService = new OpenCodeCredentialService(
  new OpenCodeNativeCredentialStore(),
);
