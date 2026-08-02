import fs from 'fs';
import path from 'path';
import { uniq } from 'lodash-es';
import { z } from 'zod';
import { getAgentDir } from '@/shared/platform/paths';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import {
  createLocalAccountDiscoveryFailure,
  createLocalAccountDiscoveryFailureByCode,
} from '../discovery-errors';
import type {
  DiscoveredCredential,
  LocalAccountDiscoverySource,
  LocalAccountSourceResult,
} from '../types';

const LEGACY_INDEX_FILENAMES = ['antigravity_accounts.json', 'accounts.json'];
const LEGACY_PROTOBUF_KEY = 'jetskiStateSync.agentManagerInitState';

const LegacyAccountPointerSchema = z
  .object({
    email: z.string().optional(),
    backup_file: z.string().optional(),
    data_file: z.string().optional(),
  })
  .passthrough();

const LegacyTokenSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string(),
    id_token: z.string().optional(),
    project_id: z.string().optional(),
    expiry_timestamp: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const LegacyBackupDataSchema = z
  .object({
    token: LegacyTokenSchema.optional(),
    [LEGACY_PROTOBUF_KEY]: z.string().optional(),
  })
  .passthrough();

const LegacyBackupSchema = z
  .object({
    token: LegacyTokenSchema.optional(),
    data: LegacyBackupDataSchema.optional(),
    [LEGACY_PROTOBUF_KEY]: z.string().optional(),
  })
  .passthrough();

interface LegacyAgentDiscoverySourceOptions {
  agentDir?: string;
}

function normalizeEmailHint(email: string | undefined): string | undefined {
  const normalized = email?.trim();
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    return undefined;
  }
  return normalized;
}

function getLegacyAccountPointers(
  value: unknown,
): Array<z.infer<typeof LegacyAccountPointerSchema>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('Malformed legacy account index');
  }

  const envelope = z
    .object({
      accounts: z.record(z.string(), LegacyAccountPointerSchema),
    })
    .passthrough()
    .safeParse(value);
  const candidateEntries = envelope.success
    ? Object.values(envelope.data.accounts)
    : Object.values(value);

  return candidateEntries.flatMap((candidate) => {
    const parsed = LegacyAccountPointerSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function resolveBackupPath(agentDir: string, rawPath: string): string | null {
  const resolvedAgentDir = path.resolve(agentDir);
  const fileName = path.basename(rawPath);
  const candidates = uniq([
    path.isAbsolute(rawPath) ? rawPath : path.join(agentDir, rawPath),
    path.join(agentDir, fileName),
    path.join(agentDir, 'backups', fileName),
    path.join(agentDir, 'accounts', fileName),
  ]);
  return (
    candidates.find((candidate) => {
      const relativePath = path.relative(resolvedAgentDir, path.resolve(candidate));
      const isInsideAgentDir =
        relativePath === '' ||
        (!relativePath.startsWith(`..${path.sep}`) &&
          relativePath !== '..' &&
          !path.isAbsolute(relativePath));
      return isInsideAgentDir && fs.existsSync(candidate);
    }) ?? null
  );
}

function extractCredential(value: unknown): DiscoveredCredential {
  const backup = LegacyBackupSchema.parse(value);
  const token = backup.token ?? backup.data?.token;
  if (token) {
    return {
      refreshToken: token.refresh_token,
      ...(token.access_token ? { accessToken: token.access_token } : {}),
      ...(token.id_token ? { idToken: token.id_token } : {}),
      ...(token.project_id ? { projectId: token.project_id } : {}),
      ...(token.expiry_timestamp !== undefined ? { expiryTimestamp: token.expiry_timestamp } : {}),
    };
  }

  const encodedState = backup[LEGACY_PROTOBUF_KEY] ?? backup.data?.[LEGACY_PROTOBUF_KEY];
  if (!encodedState) {
    throw new SyntaxError('Malformed legacy credential backup');
  }

  const tokenInfo = ProtobufUtils.extractOAuthTokenInfo(
    new Uint8Array(Buffer.from(encodedState, 'base64')),
  );
  if (!tokenInfo) {
    throw new SyntaxError('Malformed legacy OAuth protobuf');
  }
  return {
    refreshToken: tokenInfo.refreshToken,
    ...(tokenInfo.accessToken ? { accessToken: tokenInfo.accessToken } : {}),
    ...(tokenInfo.idToken ? { idToken: tokenInfo.idToken } : {}),
  };
}

export class LegacyAgentDiscoverySource implements LocalAccountDiscoverySource {
  readonly id = 'legacy-agent' as const;
  private readonly agentDir: string;

  constructor(options: LegacyAgentDiscoverySourceOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
  }

  async discover(): Promise<LocalAccountSourceResult> {
    const candidates: LocalAccountSourceResult['candidates'] = [];
    const failures: LocalAccountSourceResult['failures'] = [];
    let inspectedLocations = 0;
    let foundIndex = false;

    for (const indexFilename of LEGACY_INDEX_FILENAMES) {
      const indexPath = path.join(this.agentDir, indexFilename);
      inspectedLocations += 1;
      if (!fs.existsSync(indexPath)) {
        continue;
      }
      foundIndex = true;

      let accountPointers: Array<z.infer<typeof LegacyAccountPointerSchema>>;
      try {
        accountPointers = getLegacyAccountPointers(JSON.parse(fs.readFileSync(indexPath, 'utf-8')));
      } catch (error) {
        failures.push(
          createLocalAccountDiscoveryFailure(
            {
              id: this.id,
              location: indexPath,
            },
            error,
          ),
        );
        continue;
      }

      for (const accountPointer of accountPointers) {
        const configuredPath = accountPointer.backup_file ?? accountPointer.data_file;
        if (!configuredPath) {
          failures.push(
            createLocalAccountDiscoveryFailureByCode(
              {
                id: this.id,
                location: indexPath,
              },
              'malformed',
            ),
          );
          continue;
        }

        const backupPath = resolveBackupPath(this.agentDir, configuredPath);
        inspectedLocations += 1;
        if (!backupPath) {
          failures.push(
            createLocalAccountDiscoveryFailureByCode(
              {
                id: this.id,
                location: configuredPath,
              },
              'missing',
            ),
          );
          continue;
        }

        try {
          candidates.push({
            source: {
              id: this.id,
              location: backupPath,
            },
            credential: extractCredential(JSON.parse(fs.readFileSync(backupPath, 'utf-8'))),
            emailHint: normalizeEmailHint(accountPointer.email),
          });
        } catch (error) {
          failures.push(
            createLocalAccountDiscoveryFailure(
              {
                id: this.id,
                location: backupPath,
              },
              error,
            ),
          );
        }
      }
    }

    if (!foundIndex) {
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
      inspectedLocations,
    };
  }
}
