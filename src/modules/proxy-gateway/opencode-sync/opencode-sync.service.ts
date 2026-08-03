import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import { buildOpenCodeAccountsFile, type OpenCodeAccountLoader } from './opencode-accounts';
import type { OpenCodeCredentialService } from './opencode-credential.service';
import {
  detectOpenCodeInstallation,
  type OpenCodeInstallationDetector,
} from './opencode-installation';
import {
  clearOpenCodeConfigJsonc,
  injectOpenCodeApiKeyAfterRestore,
  type OpenCodeModelInput,
  redactOpenCodeApiKeyForBackup,
  updateOpenCodeConfigJsonc,
} from './opencode-jsonc-config';

const OPEN_CODE_DIRECTORY = join('.config', 'opencode');
const JSON_CONFIG_FILE = 'opencode.json';
const JSONC_CONFIG_FILE = 'opencode.jsonc';
const ACCOUNTS_FILE = 'antigravity-accounts.json';
const BACKUP_SUFFIX = '.antigravity-manager.bak';
const LEGACY_BACKUP_SUFFIX = '.antigravity.bak';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OpenCodeSyncInput {
  baseUrl: string;
  models?: OpenCodeModelInput[];
  syncAccounts?: boolean;
}

export interface OpenCodeClearInput {
  baseUrl: string;
  clearLegacy: boolean;
}

export interface OpenCodeSyncResult {
  configPath: string;
}

export interface OpenCodeSyncStatus {
  configPath: string;
  exists: boolean;
  hasBackup: boolean;
  isConfigured: boolean;
  isSynced: boolean;
  currentBaseUrl: string | null;
  hasAuthPlugin: boolean;
  keyConfigured: boolean;
  installed: boolean;
  version: string | null;
  models: OpenCodeModelInput[];
}

export interface OpenCodeConfigPreview {
  configPath: string;
  fileName: string;
  content: string;
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

async function writeAtomically(path: string, content: string, mode?: number): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode });
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
    private readonly detectInstallation: OpenCodeInstallationDetector = detectOpenCodeInstallation,
    private readonly loadAccounts: OpenCodeAccountLoader = async () => [],
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
    if (input.syncAccounts) {
      await this.syncAccountsFile();
    }
    return { configPath };
  }

  async restore(): Promise<OpenCodeSyncResult> {
    const backupPath = await this.findBackupPath();
    const accountsBackupPath = await this.findAccountsBackupPath();
    if (!backupPath && !accountsBackupPath) {
      throw new Error('No OpenCode backup was found');
    }

    let configPath = await this.resolveActiveConfigPath();
    if (backupPath) {
      const backup = await readFile(backupPath, 'utf8');
      const restored = injectOpenCodeApiKeyAfterRestore(backup, this.credentials.getOrCreate());
      configPath = this.getBackupTargetPath(backupPath);
      await writeAtomically(configPath, restored);
      await unlink(backupPath);
    }
    if (accountsBackupPath) {
      await this.restoreAccountsBackup(accountsBackupPath);
    }
    return { configPath };
  }

  async clear(input: OpenCodeClearInput): Promise<OpenCodeSyncResult> {
    const configPath = await this.resolveActiveConfigPath();
    if (await pathExists(configPath)) {
      const source = await readFile(configPath, 'utf8');
      const cleared = clearOpenCodeConfigJsonc(source, input);
      await this.createOrSanitizeBackup(configPath, source);
      await writeAtomically(configPath, cleared);
    }

    const accountsBackupPath = await this.findAccountsBackupPath();
    if (accountsBackupPath) {
      await this.restoreAccountsBackup(accountsBackupPath);
    } else {
      const accountsPath = this.getAccountsPath();
      if (await pathExists(accountsPath)) {
        await unlink(accountsPath);
      }
    }
    this.credentials.revoke();
    return { configPath };
  }

  async getStatus(expectedBaseUrl: string): Promise<OpenCodeSyncStatus> {
    const installationPromise = this.detectInstallation();
    const configPath = await this.resolveActiveConfigPath();
    const exists = await pathExists(configPath);
    const backupPath = await this.findBackupPath();
    let currentBaseUrl: string | null = null;
    let configuredApiKey: string | null = null;
    let hasAuthPlugin = false;
    const models: OpenCodeModelInput[] = [];

    if (exists) {
      const source = await readFile(configPath, 'utf8');
      const root: unknown = parse(source, undefined, {
        allowTrailingComma: true,
        disallowComments: false,
      });
      const provider = isUnknownRecord(root) ? root.provider : undefined;
      const plugins = isUnknownRecord(root) ? root.plugin : undefined;
      const pluginNames = Array.isArray(plugins) ? plugins : [plugins];
      hasAuthPlugin = pluginNames.some(
        (plugin) => typeof plugin === 'string' && plugin.includes('opencode-antigravity-auth'),
      );
      const managedProvider = isUnknownRecord(provider)
        ? provider['antigravity-manager']
        : undefined;
      const options = isUnknownRecord(managedProvider) ? managedProvider.options : undefined;
      const baseUrl = isUnknownRecord(options) ? options.baseURL : undefined;
      const apiKey = isUnknownRecord(options) ? options.apiKey : undefined;
      currentBaseUrl = typeof baseUrl === 'string' ? baseUrl : null;
      configuredApiKey = typeof apiKey === 'string' ? apiKey : null;

      const configuredModels = isUnknownRecord(managedProvider)
        ? managedProvider.models
        : undefined;
      if (isUnknownRecord(configuredModels)) {
        for (const [id, definition] of Object.entries(configuredModels)) {
          const name = isUnknownRecord(definition) ? definition.name : undefined;
          models.push({
            id,
            name: typeof name === 'string' ? name : undefined,
          });
        }
      }
    }

    const credentialMatches = this.credentials.matches(configuredApiKey);
    const installation = await installationPromise;

    return {
      configPath,
      exists,
      hasBackup: Boolean(backupPath),
      isConfigured: Boolean(currentBaseUrl) && credentialMatches,
      isSynced: currentBaseUrl === normalizeBaseUrl(expectedBaseUrl) && credentialMatches,
      currentBaseUrl,
      hasAuthPlugin,
      keyConfigured: this.credentials.hasKey(),
      installed: installation.installed,
      version: installation.version,
      models,
    };
  }

  async readConfigForDisplay(): Promise<OpenCodeConfigPreview> {
    const configPath = await this.resolveActiveConfigPath();
    if (!(await pathExists(configPath))) {
      throw new Error('OpenCode configuration was not found');
    }

    const source = await readFile(configPath, 'utf8');
    const errors: ParseError[] = [];
    const root: unknown = parse(source, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0 || !isUnknownRecord(root)) {
      throw new Error('OpenCode configuration is not a valid JSONC object');
    }

    return {
      configPath,
      fileName: basename(configPath),
      content: `${JSON.stringify(sanitizeObject(root), null, 2)}\n`,
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

  private getAccountsPath(): string {
    return join(this.configDirectory, ACCOUNTS_FILE);
  }

  private async syncAccountsFile(): Promise<void> {
    const accountsPath = this.getAccountsPath();
    const exists = await pathExists(accountsPath);
    if (exists) {
      const backupPath = `${accountsPath}${BACKUP_SUFFIX}`;
      if (!(await pathExists(backupPath))) {
        const backupSource = await readFile(accountsPath, 'utf8');
        await writeAtomically(backupPath, backupSource, 0o600);
      }
    }

    const source = exists ? await readFile(accountsPath, 'utf8') : null;
    const accounts = await this.loadAccounts();
    const output = buildOpenCodeAccountsFile(source, accounts);
    await writeAtomically(accountsPath, `${JSON.stringify(output, null, 2)}\n`, 0o600);
  }

  private async findAccountsBackupPath(): Promise<string | null> {
    const accountsPath = this.getAccountsPath();
    for (const path of [
      `${accountsPath}${BACKUP_SUFFIX}`,
      `${accountsPath}${LEGACY_BACKUP_SUFFIX}`,
    ]) {
      if (await pathExists(path)) {
        return path;
      }
    }
    return null;
  }

  private async restoreAccountsBackup(backupPath: string): Promise<void> {
    const accountsPath = this.getAccountsPath();
    if (await pathExists(accountsPath)) {
      await unlink(accountsPath);
    }
    await rename(backupPath, accountsPath);
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
