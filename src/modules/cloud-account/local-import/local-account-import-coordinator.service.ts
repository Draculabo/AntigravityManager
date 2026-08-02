import { randomUUID } from 'crypto';
import {
  createDefaultLocalAccountDiscoveryService,
  type LocalAccountDiscoverySession,
} from './local-account-discovery.service';
import { LocalAccountImportService } from './local-account-import.service';
import type { LocalAccountImportResult, LocalAccountPostImportTaskSnapshot } from './import-types';
import { localAccountPostImportService } from './local-account-post-import.service';
import {
  LocalAccountValidationService,
  type LocalAccountValidationSession,
} from './local-account-validation.service';
import type {
  LocalAccountDiscoveryFailure,
  LocalAccountEmailCollisionGroup,
  LocalAccountSourceSummary,
} from './types';
import type {
  LocalAccountValidationFailure,
  LocalAccountValidationMerge,
  ValidatedLocalAccountSummary,
} from './validation-types';

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 8;
const MAX_SESSION_ID_ATTEMPTS = 8;

export type LocalAccountImportCoordinatorErrorCode =
  | 'preview-failed'
  | 'session-not-found'
  | 'session-expired'
  | 'session-consumed'
  | 'background-task-not-found'
  | 'confirmation-failed';

const ERROR_MESSAGES: Record<LocalAccountImportCoordinatorErrorCode, string> = {
  'preview-failed': 'The local account preview could not be prepared.',
  'session-not-found': 'The local account import session was not found.',
  'session-expired': 'The local account import session has expired.',
  'session-consumed': 'The local account import session has already been consumed.',
  'background-task-not-found': 'The local account post-import task was not found.',
  'confirmation-failed': 'The local account import could not be completed.',
};

export class LocalAccountImportCoordinatorError extends Error {
  constructor(readonly code: LocalAccountImportCoordinatorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'LocalAccountImportCoordinatorError';
  }
}

export interface LocalAccountImportPreview {
  sessionId: string;
  expiresAt: number;
  accounts: ValidatedLocalAccountSummary[];
  validationFailures: LocalAccountValidationFailure[];
  discoveryFailures: LocalAccountDiscoveryFailure[];
  merged: LocalAccountValidationMerge[];
  sourceSummaries: LocalAccountSourceSummary[];
  duplicateCount: number;
  emailCollisionGroups: LocalAccountEmailCollisionGroup[];
}

export interface LocalAccountImportCoordinatorDependencies {
  discover: () => Promise<LocalAccountDiscoverySession>;
  validate: (session: LocalAccountDiscoverySession) => Promise<LocalAccountValidationSession>;
  importSession: (session: LocalAccountValidationSession) => Promise<LocalAccountImportResult>;
  schedulePostImport: (accountIds: string[]) => string | undefined;
  getPostImportStatus: (taskId: string) => LocalAccountPostImportTaskSnapshot | undefined;
  createSessionId: () => string;
  now: () => number;
}

export interface LocalAccountImportCoordinatorOptions {
  dependencies?: LocalAccountImportCoordinatorDependencies;
  sessionTtlMs?: number;
  maxActiveSessions?: number;
  maxTerminalSessions?: number;
}

interface ActiveSession {
  expiresAt: number;
  session: LocalAccountValidationSession;
}

interface TerminalSession {
  code: 'session-expired' | 'session-consumed';
  forgetAt: number;
}

function createDefaultDependencies(): LocalAccountImportCoordinatorDependencies {
  const discoveryService = createDefaultLocalAccountDiscoveryService();
  const validationService = new LocalAccountValidationService();
  const importService = new LocalAccountImportService();
  return {
    discover: () => discoveryService.discover(),
    validate: (session) => validationService.validate(session),
    importSession: (session) => importService.importSession(session),
    schedulePostImport: (accountIds) => localAccountPostImportService.schedule(accountIds),
    getPostImportStatus: (taskId) => localAccountPostImportService.getStatus(taskId),
    createSessionId: randomUUID,
    now: Date.now,
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function copyPreview(
  sessionId: string,
  expiresAt: number,
  discoverySession: LocalAccountDiscoverySession,
  validationSession: LocalAccountValidationSession,
): LocalAccountImportPreview {
  return {
    sessionId,
    expiresAt,
    accounts: validationSession.result.accounts.map((account) => ({
      ...account,
      sources: account.sources.map((source) => ({ ...source })),
      emailHints: [...account.emailHints],
      identity: { ...account.identity },
    })),
    validationFailures: validationSession.result.failed.map((failure) => ({ ...failure })),
    discoveryFailures: validationSession.result.discoveryFailures.map((failure) => ({
      ...failure,
      source: { ...failure.source },
    })),
    merged: validationSession.result.merged.map((merge) => ({
      ...merge,
      mergedFingerprints: [...merge.mergedFingerprints],
    })),
    sourceSummaries: discoverySession.result.sourceSummaries.map((summary) => ({ ...summary })),
    duplicateCount: discoverySession.result.duplicateCount,
    emailCollisionGroups: discoverySession.result.emailCollisionGroups.map((group) => ({
      ...group,
      fingerprints: [...group.fingerprints],
    })),
  };
}

/**
 * Owns the short-lived credential capability between preview and confirmation.
 *
 * Raw credentials never leave this service. A confirmation removes its session
 * synchronously before persistence starts, so concurrent or retried IPC calls
 * cannot replay the same credential batch.
 */
export class LocalAccountImportCoordinatorService {
  private readonly dependencies: LocalAccountImportCoordinatorDependencies;
  private readonly sessionTtlMs: number;
  private readonly maxActiveSessions: number;
  private readonly maxTerminalSessions: number;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly terminalSessions = new Map<string, TerminalSession>();

  constructor(options: LocalAccountImportCoordinatorOptions = {}) {
    this.dependencies = options.dependencies ?? createDefaultDependencies();
    this.sessionTtlMs = normalizePositiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
    this.maxActiveSessions = normalizePositiveInteger(
      options.maxActiveSessions,
      DEFAULT_MAX_ACTIVE_SESSIONS,
    );
    this.maxTerminalSessions = normalizePositiveInteger(
      options.maxTerminalSessions,
      this.maxActiveSessions * 4,
    );
  }

  async preview(): Promise<LocalAccountImportPreview> {
    try {
      const discoverySession = await this.dependencies.discover();
      const validationSession = await this.dependencies.validate(discoverySession);
      const now = this.dependencies.now();
      this.cleanup(now);
      this.evictOldestSessions(now);
      const sessionId = this.createUniqueSessionId();
      const expiresAt = now + this.sessionTtlMs;
      this.activeSessions.set(sessionId, {
        expiresAt,
        session: validationSession,
      });
      return copyPreview(sessionId, expiresAt, discoverySession, validationSession);
    } catch {
      throw new LocalAccountImportCoordinatorError('preview-failed');
    }
  }

  async confirm(sessionId: string): Promise<LocalAccountImportResult> {
    const now = this.dependencies.now();
    this.cleanup(now);
    const activeSession = this.activeSessions.get(sessionId);
    if (!activeSession) {
      throw this.createUnavailableSessionError(sessionId);
    }

    // Consume before the first asynchronous boundary to make replay impossible.
    this.activeSessions.delete(sessionId);
    this.rememberTerminalSession(sessionId, 'session-consumed', now);
    let result: LocalAccountImportResult;
    try {
      result = await this.dependencies.importSession(activeSession.session);
    } catch {
      throw new LocalAccountImportCoordinatorError('confirmation-failed');
    }

    // Persistence has already committed. Background scheduling must never turn
    // a successful import into a failed confirmation response.
    try {
      const postImportTaskId = this.dependencies.schedulePostImport(
        result.imported.map((account) => account.accountId),
      );
      return postImportTaskId ? { ...result, postImportTaskId } : result;
    } catch {
      return result;
    }
  }

  discard(sessionId: string): { discarded: boolean } {
    const now = this.dependencies.now();
    this.cleanup(now);
    if (!this.activeSessions.delete(sessionId)) {
      return { discarded: false };
    }
    this.rememberTerminalSession(sessionId, 'session-consumed', now);
    return { discarded: true };
  }

  getPostImportStatus(taskId: string): LocalAccountPostImportTaskSnapshot {
    const status = this.dependencies.getPostImportStatus(taskId);
    if (!status) {
      throw new LocalAccountImportCoordinatorError('background-task-not-found');
    }
    return status;
  }

  private cleanup(now: number): void {
    for (const [sessionId, terminal] of this.terminalSessions) {
      if (terminal.forgetAt <= now) {
        this.terminalSessions.delete(sessionId);
      }
    }
    for (const [sessionId, active] of this.activeSessions) {
      if (active.expiresAt <= now) {
        this.activeSessions.delete(sessionId);
        this.rememberTerminalSession(sessionId, 'session-expired', now);
      }
    }
  }

  private evictOldestSessions(now: number): void {
    while (this.activeSessions.size >= this.maxActiveSessions) {
      const oldestSessionId = this.activeSessions.keys().next().value;
      if (typeof oldestSessionId !== 'string') {
        return;
      }
      this.activeSessions.delete(oldestSessionId);
      this.rememberTerminalSession(oldestSessionId, 'session-expired', now);
    }
  }

  private createUniqueSessionId(): string {
    for (let attempt = 0; attempt < MAX_SESSION_ID_ATTEMPTS; attempt += 1) {
      const sessionId = this.dependencies.createSessionId();
      if (!this.activeSessions.has(sessionId) && !this.terminalSessions.has(sessionId)) {
        return sessionId;
      }
    }
    throw new LocalAccountImportCoordinatorError('preview-failed');
  }

  private rememberTerminalSession(
    sessionId: string,
    code: TerminalSession['code'],
    now: number,
  ): void {
    while (this.terminalSessions.size >= this.maxTerminalSessions) {
      const oldestSessionId = this.terminalSessions.keys().next().value;
      if (typeof oldestSessionId !== 'string') {
        break;
      }
      this.terminalSessions.delete(oldestSessionId);
    }
    this.terminalSessions.set(sessionId, {
      code,
      forgetAt: now + this.sessionTtlMs,
    });
  }

  private createUnavailableSessionError(sessionId: string): LocalAccountImportCoordinatorError {
    const terminal = this.terminalSessions.get(sessionId);
    return new LocalAccountImportCoordinatorError(terminal?.code ?? 'session-not-found');
  }
}

export const localAccountImportCoordinator = new LocalAccountImportCoordinatorService();
