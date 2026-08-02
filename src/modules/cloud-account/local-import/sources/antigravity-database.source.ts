import fs from 'fs';
import { uniq } from 'lodash-es';
import type { AntigravityAppTarget } from '@/modules/account/types';
import {
  IdeAccountImportAdapter,
  type IdeTokenInfo,
} from '@/modules/cloud-account/persistence/ide-account-import-adapter';
import { getAntigravityDbPaths } from '@/shared/platform/paths';
import {
  createLocalAccountDiscoveryFailure,
  createLocalAccountDiscoveryFailureByCode,
} from '../discovery-errors';
import type {
  LocalAccountDiscoverySource,
  LocalAccountDiscoverySourceId,
  LocalAccountSourceResult,
} from '../types';

type DatabaseDiscoveryTarget = Extract<AntigravityAppTarget, 'classic' | 'ide'>;

interface AntigravityDatabaseDiscoverySourceDependencies {
  existsSync: (candidatePath: string) => boolean;
  getDbPaths: (target: DatabaseDiscoveryTarget) => string[];
  readTokenInfoFromPath: (dbPath: string) => IdeTokenInfo;
}

function getSourceId(target: DatabaseDiscoveryTarget): LocalAccountDiscoverySourceId {
  return target === 'ide' ? 'antigravity-ide-db' : 'antigravity-classic-db';
}

export class AntigravityDatabaseDiscoverySource implements LocalAccountDiscoverySource {
  readonly id: LocalAccountDiscoverySourceId;

  constructor(
    private readonly target: DatabaseDiscoveryTarget,
    private readonly dependencies: AntigravityDatabaseDiscoverySourceDependencies = {
      existsSync: fs.existsSync,
      getDbPaths: getAntigravityDbPaths,
      readTokenInfoFromPath: (dbPath) => IdeAccountImportAdapter.readTokenInfoFromPath(dbPath),
    },
  ) {
    this.id = getSourceId(target);
  }

  async discover(): Promise<LocalAccountSourceResult> {
    const candidates: LocalAccountSourceResult['candidates'] = [];
    const failures: LocalAccountSourceResult['failures'] = [];
    const dbPaths = uniq(this.dependencies.getDbPaths(this.target));
    let existingPathCount = 0;

    for (const dbPath of dbPaths) {
      const source = {
        id: this.id,
        location: dbPath,
      };
      try {
        if (!this.dependencies.existsSync(dbPath)) {
          continue;
        }
        existingPathCount += 1;
        const tokenInfo = this.dependencies.readTokenInfoFromPath(dbPath);
        candidates.push({
          source,
          credential: {
            refreshToken: tokenInfo.refreshToken,
            ...(tokenInfo.accessToken ? { accessToken: tokenInfo.accessToken } : {}),
            ...(tokenInfo.idToken ? { idToken: tokenInfo.idToken } : {}),
            ...(tokenInfo.projectId ? { projectId: tokenInfo.projectId } : {}),
          },
        });
      } catch (error) {
        failures.push(createLocalAccountDiscoveryFailure(source, error));
      }
    }

    if (existingPathCount === 0) {
      failures.push(
        createLocalAccountDiscoveryFailureByCode(
          {
            id: this.id,
          },
          'missing',
        ),
      );
    }

    return {
      candidates,
      failures,
      inspectedLocations: dbPaths.length,
    };
  }
}
