import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import { configureClaude, readClaudeSettings, removeClaudeConnection } from './claude-settings';
import { configureCodex, inspectCodexSettings, removeCodexConnection } from './codex-settings';
import {
  AgentToolError,
  AgentToolStatusSchema,
  type AgentTool,
  type AgentToolConfigure,
  type AgentToolStatus,
} from './agent-tools.schema';

const MAX_BYTES = 256 * 1024;
const backupSchema = z.strictObject({
  version: z.literal(1),
  original: z.string().max(MAX_BYTES).nullable(),
});
interface Dependencies {
  home: string;
  env: Pick<NodeJS.ProcessEnv, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'>;
  key(): Promise<string>;
  ensureReviewRoute(model: string): Promise<void>;
  detect(tool: AgentTool): Promise<{ installed: boolean; version: string | null }>;
  write?: typeof writeFileAtomic;
}
function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function read(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > MAX_BYTES * 3) {
      throw new AgentToolError('invalid-config');
    }
    const source = await readFile(path, 'utf8');
    if (Buffer.byteLength(source) > MAX_BYTES * 3) {
      throw new AgentToolError('invalid-config');
    }
    return source;
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error instanceof AgentToolError ? error : new AgentToolError('read-failed');
  }
}
export function normalizeAgentToolUrl(tool: AgentTool, input: string) {
  const trimmed = input.replace(/\/+$/, '');
  const root = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return tool === 'codex' ? `${root}/v1` : root;
}

/** One admitted queue serializes preview, backup, writes and shutdown for both clients. */
export class AgentToolsService {
  private queue: Promise<unknown> = Promise.resolve();
  private accepting = true;
  private readonly write: typeof writeFileAtomic;
  constructor(private readonly dependencies: Dependencies) {
    this.write = dependencies.write ?? writeFileAtomic;
  }
  closeAdmission() {
    this.accepting = false;
  }
  async drain() {
    await this.queue.catch(() => undefined);
  }
  private execute<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new AgentToolError('unavailable'));
    }
    const task = this.queue.catch(() => undefined).then(work);
    this.queue = task;
    return task;
  }
  private path(tool: AgentTool) {
    return tool === 'claude'
      ? join(
          this.dependencies.env.CLAUDE_CONFIG_DIR ?? join(this.dependencies.home, '.claude'),
          'settings.json',
        )
      : join(
          this.dependencies.env.CODEX_HOME ?? join(this.dependencies.home, '.codex'),
          'config.toml',
        );
  }
  private empty(tool: AgentTool) {
    return tool === 'claude' ? '{}\n' : '';
  }
  private async backup(path: string) {
    const source = await read(`${path}.antigravity-manager.bak`);
    if (source === null) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new AgentToolError('invalid-config');
    }
    const result = backupSchema.safeParse(value);
    if (!result.success) {
      throw new AgentToolError('invalid-config');
    }
    return result.data;
  }
  status(tool: AgentTool, baseUrl: string): Promise<AgentToolStatus> {
    return this.execute(async () => {
      const configPath = this.path(tool);
      const source = await read(configPath);
      const hasBackup = (await this.backup(configPath)) !== null;
      let currentBaseUrl: string | null = null;
      let model: string | null = null;
      let key: string | null = null;
      let selected = false;
      if (source !== null) {
        if (tool === 'claude') {
          const parsed = readClaudeSettings(source);
          currentBaseUrl =
            typeof parsed.env?.ANTHROPIC_BASE_URL === 'string'
              ? parsed.env.ANTHROPIC_BASE_URL
              : null;
          key =
            typeof parsed.env?.ANTHROPIC_API_KEY === 'string' ? parsed.env.ANTHROPIC_API_KEY : null;
          model = parsed.model ?? null;
          selected = true;
        } else {
          const parsed = inspectCodexSettings(source);
          currentBaseUrl = parsed.baseUrl;
          key = parsed.key;
          model = parsed.model;
          selected = parsed.selected;
        }
      }
      const currentKey = await this.dependencies.key();
      const isConfigured = Boolean(selected && currentBaseUrl && currentKey && key === currentKey);
      return AgentToolStatusSchema.parse({
        tool,
        configPath,
        exists: source !== null,
        hasBackup,
        isConfigured,
        isSynced: isConfigured && currentBaseUrl === normalizeAgentToolUrl(tool, baseUrl),
        currentBaseUrl,
        model,
        ...(await this.dependencies.detect(tool)),
      });
    });
  }
  configure(input: AgentToolConfigure) {
    return this.execute(async () => {
      const configPath = this.path(input.tool);
      const original = await read(configPath);
      if (original !== null && Buffer.byteLength(original) > MAX_BYTES) {
        throw new AgentToolError('invalid-config');
      }
      const key = await this.dependencies.key();
      if (!key) {
        throw new AgentToolError('key-missing');
      }
      const address = normalizeAgentToolUrl(input.tool, input.baseUrl);
      const source = original ?? this.empty(input.tool);
      const next =
        input.tool === 'claude'
          ? configureClaude(source, address, input.model, key)
          : configureCodex(source, address, input.model, key);
      if (!(await this.backup(configPath))) {
        try {
          await this.write(
            `${configPath}.antigravity-manager.bak`,
            JSON.stringify({ version: 1, original }),
            { mode: 0o600 },
          );
        } catch {
          throw new AgentToolError('backup-failed');
        }
      }
      // The additive review route is retained on restore: other Codex profiles can depend on it.
      if (input.tool === 'codex') {
        await this.dependencies.ensureReviewRoute(input.model);
      }
      if ((await read(configPath)) !== original) {
        throw new AgentToolError('configuration-changed');
      }
      try {
        await this.write(configPath, next, { mode: 0o600 });
      } catch {
        throw new AgentToolError('write-failed');
      }
      return { configPath, restartRequired: true as const };
    });
  }
  preview(tool: AgentTool) {
    return this.execute(async () => {
      const configPath = this.path(tool);
      const source = await read(configPath);
      if (source === null) {
        throw new AgentToolError('read-failed');
      }
      // Only connection fields cross RPC; unrelated settings may contain private credentials.
      let model: string | null;
      let baseUrl: string | null;
      if (tool === 'claude') {
        const settings = readClaudeSettings(source);
        model = settings.model ?? null;
        baseUrl =
          typeof settings.env?.ANTHROPIC_BASE_URL === 'string'
            ? settings.env.ANTHROPIC_BASE_URL
            : null;
      } else {
        const settings = inspectCodexSettings(source);
        model = settings.model;
        baseUrl = settings.baseUrl;
      }
      return {
        configPath,
        content: JSON.stringify(
          sanitizeObject({ model, baseUrl, credential: '[REDACTED]' }),
          null,
          2,
        ),
      };
    });
  }
  restore(tool: AgentTool) {
    return this.execute(async () => {
      const configPath = this.path(tool);
      const backup = await this.backup(configPath);
      if (!backup) {
        throw new AgentToolError('backup-missing');
      }
      try {
        if (backup.original === null) {
          await unlink(configPath).catch((error) => {
            if (!missing(error)) {
              throw error;
            }
          });
        } else {
          await this.write(configPath, backup.original, { mode: 0o600 });
        }
        await unlink(`${configPath}.antigravity-manager.bak`);
      } catch {
        throw new AgentToolError('write-failed');
      }
      return { configPath, restartRequired: true as const };
    });
  }
  remove(tool: AgentTool) {
    return this.execute(async () => {
      const configPath = this.path(tool);
      const source = await read(configPath);
      const backup = await this.backup(configPath);
      if (!backup || source === null) {
        throw new AgentToolError('backup-missing');
      }
      if (tool === 'claude') {
        const current = readClaudeSettings(source);
        if (current.env?.ANTHROPIC_API_KEY !== (await this.dependencies.key())) {
          throw new AgentToolError('configuration-changed');
        }
      } else if (!inspectCodexSettings(source).selected) {
        throw new AgentToolError('configuration-changed');
      }
      const next =
        tool === 'claude'
          ? removeClaudeConnection(source, backup.original)
          : removeCodexConnection(source, backup.original);
      try {
        await this.write(configPath, next, { mode: 0o600 });
      } catch {
        throw new AgentToolError('write-failed');
      }
      return { configPath, restartRequired: true as const };
    });
  }
}
export type AgentToolsOperations = Pick<
  AgentToolsService,
  'status' | 'configure' | 'preview' | 'restore' | 'remove'
>;
