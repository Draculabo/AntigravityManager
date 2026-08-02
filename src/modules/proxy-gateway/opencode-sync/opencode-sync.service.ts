import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import type { OpenCodeCredentialService } from './opencode-credential.service';
import {
  injectOpenCodeApiKeyAfterRestore,
  type OpenCodeModelInput,
  redactOpenCodeApiKeyForBackup,
  updateOpenCodeConfigJsonc,
} from './opencode-jsonc-config';

const OPEN_CODE_DIRECTORY = join('.config', 'opencode');
const JSON_CONFIG_FILE = 'opencode.json';
const JSONC_CONFIG_FILE = 'opencode.jsonc';
const BACKUP_SUFFIX = '.antigravity-manager.bak';
const LEGACY_BACKUP_SUFFIX = '.antigravity.bak';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OpenCodeSyncInput {
  baseUrl: string;
  models?: OpenCodeModelInput[];
}

export interface OpenCodeSyncResult {
  configPath: string;
}

export interface OpenCodeSyncStatus {
  configPath: string;
  exists: boolean;
  hasBackup: boolean;
  isSynced: boolean;
  currentBaseUrl: string | null;
  keyConfigured: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class OpenCodeSyncService {
  private readonly configDirectory: string;

  constructor(
    homeDirectory: string,
    private readonly credentials: OpenCodeCredentialService,
  ) {
    this.configDirectory = join(homeDirectory, OPEN_CODE_DIRECTORY);
  }

  async sync(input: OpenCodeSyncInput): Promise<OpenCodeSyncResult> {
    await mkdir(this.configDirectory, { recursive: true });
    const configPath = await this.resolveActiveConfigPath();
    const exists = await pathExists(configPath);
    const source = exists ? await readFile(configPath, 'utf8') : '{}\n';

    // Validate and build the complete update before creating files.
    const key = this.credentials.getOrCreate();
    const updated = updateOpenCodeConfigJsonc(source, {
      apiKey: key,
      baseUrl: input.baseUrl,
      models: input.models,
    });

    if (exists) {
      await this.createOrSanitizeBackup(configPath, source);
    }
    await writeAtomically(configPath, updated);
    return { configPath };
  }

  async restore(): Promise<OpenCodeSyncResult> {
    const backupPath = await this.findBackupPath();
    if (!backupPath) {
      throw new Error('No OpenCode backup was found');
    }

    const backup = await readFile(backupPath, 'utf8');
    const restored = injectOpenCodeApiKeyAfterRestore(backup, this.credentials.getOrCreate());
    const configPath = this.getBackupTargetPath(backupPath);
    await writeAtomically(configPath, restored);
    await unlink(backupPath);
    return { configPath };
  }

  async getStatus(expectedBaseUrl: string): Promise<OpenCodeSyncStatus> {
    const configPath = await this.resolveActiveConfigPath();
    const exists = await pathExists(configPath);
    const backupPath = await this.findBackupPath();
    let currentBaseUrl: string | null = null;
    let configuredApiKey: string | null = null;

    if (exists) {
      const source = await readFile(configPath, 'utf8');
      const root: unknown = parse(source, undefined, {
        allowTrailingComma: true,
        disallowComments: false,
      });
      const provider = isUnknownRecord(root) ? root.provider : undefined;
      const managedProvider = isUnknownRecord(provider)
        ? provider['antigravity-manager']
        : undefined;
      const options = isUnknownRecord(managedProvider) ? managedProvider.options : undefined;
      const baseUrl = isUnknownRecord(options) ? options.baseURL : undefined;
      const apiKey = isUnknownRecord(options) ? options.apiKey : undefined;
      currentBaseUrl = typeof baseUrl === 'string' ? baseUrl : null;
      configuredApiKey = typeof apiKey === 'string' ? apiKey : null;
    }

    return {
      configPath,
      exists,
      hasBackup: Boolean(backupPath),
      isSynced:
        currentBaseUrl === normalizeBaseUrl(expectedBaseUrl) &&
        this.credentials.matches(configuredApiKey),
      currentBaseUrl,
      keyConfigured: this.credentials.hasKey(),
    };
  }

  private async resolveActiveConfigPath(): Promise<string> {
    const jsoncPath = join(this.configDirectory, JSONC_CONFIG_FILE);
    if (await pathExists(jsoncPath)) {
      return jsoncPath;
    }
    return join(this.configDirectory, JSON_CONFIG_FILE);
  }

  private async createOrSanitizeBackup(configPath: string, source: string): Promise<void> {
    const backupPath = `${configPath}${BACKUP_SUFFIX}`;
    const backupSource = (await pathExists(backupPath))
      ? await readFile(backupPath, 'utf8')
      : source;

    let redacted: string;
    try {
      redacted = redactOpenCodeApiKeyForBackup(backupSource);
    } catch {
      // An unparseable legacy backup may contain an unknown historical key.
      // Replace it with a redacted snapshot of the validated current config.
      redacted = redactOpenCodeApiKeyForBackup(source);
    }
    await writeAtomically(backupPath, redacted);
  }

  private async findBackupPath(): Promise<string | null> {
    const activePath = await this.resolveActiveConfigPath();
    const paths = [
      `${activePath}${BACKUP_SUFFIX}`,
      `${activePath}${LEGACY_BACKUP_SUFFIX}`,
      join(this.configDirectory, `${JSONC_CONFIG_FILE}${BACKUP_SUFFIX}`),
      join(this.configDirectory, `${JSONC_CONFIG_FILE}${LEGACY_BACKUP_SUFFIX}`),
      join(this.configDirectory, `${JSON_CONFIG_FILE}${BACKUP_SUFFIX}`),
      join(this.configDirectory, `${JSON_CONFIG_FILE}${LEGACY_BACKUP_SUFFIX}`),
    ];
    for (const path of new Set(paths)) {
      if (await pathExists(path)) {
        return path;
      }
    }
    return null;
  }

  private getBackupTargetPath(backupPath: string): string {
    if (backupPath.endsWith(BACKUP_SUFFIX)) {
      return backupPath.slice(0, -BACKUP_SUFFIX.length);
    }
    return backupPath.slice(0, -LEGACY_BACKUP_SUFFIX.length);
  }
}
