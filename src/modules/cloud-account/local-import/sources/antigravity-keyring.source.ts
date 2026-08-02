import { readAntigravityCredentialStoreToken } from '@/modules/cloud-account/persistence/antigravityCredentialStore';
import {
  createLocalAccountDiscoveryFailure,
  createLocalAccountDiscoveryFailureByCode,
} from '../discovery-errors';
import type { LocalAccountDiscoverySource, LocalAccountSourceResult } from '../types';

interface AntigravityKeyringDiscoverySourceDependencies {
  readCredential: typeof readAntigravityCredentialStoreToken;
}

export class AntigravityKeyringDiscoverySource implements LocalAccountDiscoverySource {
  readonly id = 'antigravity-keyring' as const;

  constructor(
    private readonly dependencies: AntigravityKeyringDiscoverySourceDependencies = {
      readCredential: readAntigravityCredentialStoreToken,
    },
  ) {}

  async discover(): Promise<LocalAccountSourceResult> {
    const source = { id: this.id };
    try {
      const credential = this.dependencies.readCredential();
      if (!credential) {
        return {
          candidates: [],
          failures: [createLocalAccountDiscoveryFailureByCode(source, 'missing')],
          inspectedLocations: 1,
        };
      }

      return {
        candidates: [
          {
            source,
            credential,
          },
        ],
        failures: [],
        inspectedLocations: 1,
      };
    } catch (error) {
      return {
        candidates: [],
        failures: [createLocalAccountDiscoveryFailure(source, error)],
        inspectedLocations: 1,
      };
    }
  }
}
