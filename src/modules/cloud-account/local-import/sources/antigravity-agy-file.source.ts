import { readAgyAccountToken } from '@/modules/antigravity-runtime';
import { createLocalAccountDiscoveryFailure } from '../discovery-errors';
import type {
  LocalAccountDiscoverySource,
  LocalAccountSourceReference,
  LocalAccountSourceResult,
} from '../types';

export class AntigravityAgyFileDiscoverySource implements LocalAccountDiscoverySource {
  readonly id = 'antigravity-agy-file';

  async discover(): Promise<LocalAccountSourceResult> {
    const source: LocalAccountSourceReference = { id: this.id };
    try {
      const credential = await readAgyAccountToken();
      return {
        candidates: credential ? [{ source, credential }] : [],
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
