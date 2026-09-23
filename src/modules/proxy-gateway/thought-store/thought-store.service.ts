import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ThoughtStoreConfig } from '@/modules/config/types';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import type {
  GeminiContent,
  GeminiInternalRequest,
} from '@/modules/proxy-gateway/antigravity/types';
import { getTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { recordProxyThinkingFill } from '@/modules/proxy-gateway/server/common/proxy-response-timing';
import { getServerConfig } from '@/server/server-config';
import { logger } from '@/shared/logging/logger';
import { getProxyStateDir } from '@/shared/platform/paths';
import { preserveCorruptSqliteDatabase } from '@/shared/persistence/database/preserve-corrupt-sqlite';
import { BoundedSqliteWorker } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import type { DatabaseRepairResult } from '../audit/traffic-audit.service';
import {
  ThoughtSessionListSchema,
  ThoughtRecordSummaryListSchema,
  ThoughtStoreStatsSchema,
  type ThoughtRecord,
  type ThoughtRecordInput,
  type ThoughtRecordSummary,
  type ThoughtSessionSummary,
  type ThoughtStoreStats,
} from './thought-store.types';
import {
  findExistingThoughtRecordIndex,
  hasThoughtTools,
  isStrongerThoughtRecord,
} from './thought-store.matching';
import type { ThoughtStoreWorkerCommand } from './thought-store.worker-protocol';

const THOUGHT_STORE_FILENAME = 'thinking-store.db';
const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';
const MIN_REAL_SIGNATURE_LENGTH = 50;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
const MAX_QUEUE_COMMANDS = 256;
export const HARD_MAX_THOUGHT_TURNS = 200;
export const HARD_MAX_THOUGHT_SESSION_BYTES = 64 * 1024 * 1024;

interface MemorySession {
  lastAccessed: number;
  loaded: boolean;
  records: ThoughtRecord[];
}

export function enforceThoughtSessionLimits(
  records: ThoughtRecord[],
  config: Pick<ThoughtStoreConfig, 'max_session_mib' | 'max_turns_per_session'>,
): void {
  const maxTurns = Math.min(HARD_MAX_THOUGHT_TURNS, Math.max(1, config.max_turns_per_session));
  const maxBytes = Math.min(
    HARD_MAX_THOUGHT_SESSION_BYTES,
    Math.max(1, config.max_session_mib) * 1024 * 1024,
  );
  while (records.length > maxTurns) {
    records.shift();
  }
  let bytes = records.reduce(
    (total, record) => total + Buffer.byteLength(record.thought, 'utf-8'),
    0,
  );
  while (bytes > maxBytes && records.length > 0) {
    const removed = records.shift();
    bytes -= removed ? Buffer.byteLength(removed.thought, 'utf-8') : 0;
  }
}

function resolveThoughtSessionLimits(
  config: Pick<ThoughtStoreConfig, 'max_session_mib' | 'max_turns_per_session'>,
): { maxBytes: number; maxTurns: number } {
  return {
    maxBytes: Math.min(
      HARD_MAX_THOUGHT_SESSION_BYTES,
      Math.max(1, config.max_session_mib) * 1024 * 1024,
    ),
    maxTurns: Math.min(HARD_MAX_THOUGHT_TURNS, Math.max(1, config.max_turns_per_session)),
  };
}

export class ThoughtStoreService {
  private worker: BoundedSqliteWorker | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private readonly sessions = new Map<string, MemorySession>();
  private readonly hydration = new Map<string, Promise<ThoughtRecord[]>>();
  private writeFailures = 0;
  private repairInProgress: Promise<DatabaseRepairResult> | null = null;

  public isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  public getCurrentSessionKey(): string | null {
    return getTrafficAuditRequestContext()?.thoughtSessionKey ?? null;
  }

  public async prepareInternalRequest(body: GeminiInternalRequest, model: string): Promise<void> {
    const sessionKey = this.getCurrentSessionKey();
    if (!sessionKey || !this.isEnabled()) {
      return;
    }
    const contents = body.request.contents;
    if (!Array.isArray(contents)) {
      return;
    }

    const startedAt = performance.now();
    try {
      await this.ensureHydrated(sessionKey);
      this.ingestContents(sessionKey, contents, model, true);
      this.restoreContents(sessionKey, contents, model);
    } finally {
      recordProxyThinkingFill(startedAt);
    }
  }

  public captureGeminiResponse(sessionKey: string | null, response: unknown, model: string): void {
    if (!sessionKey || !this.isEnabled()) {
      return;
    }
    const contents = responseToContents(response);
    if (contents.length === 0) {
      return;
    }
    this.ingestContents(sessionKey, contents, model);
  }

  public captureGeminiSse(sessionKey: string | null, raw: string, model: string): void {
    if (!sessionKey || !this.isEnabled()) {
      return;
    }
    const responses: unknown[] = [];
    for (const line of raw.split(/\r?\n/gu)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }
      try {
        responses.push(JSON.parse(data));
      } catch {
        // Malformed SSE remains an audit concern; do not invent Thought records from it.
      }
    }
    for (const response of responses) {
      this.captureGeminiResponse(sessionKey, response, model);
    }
  }

  public async listSessions(
    limit = 100,
    offset = 0,
    search?: string,
    model?: string,
  ): Promise<ThoughtSessionSummary[]> {
    return ThoughtSessionListSchema.parse(
      await this.request('listSessions', {
        limit: Math.min(Math.max(limit, 1), 200),
        model: model?.trim() || undefined,
        offset: Math.max(offset, 0),
        search: search?.trim() || undefined,
      }),
    );
  }

  public async getSession(sessionKey: string): Promise<ThoughtRecord[]> {
    return parseThoughtRecords(await this.request('getSession', { sessionKey }));
  }

  public async listRecords(sessionKey: string): Promise<ThoughtRecordSummary[]> {
    return ThoughtRecordSummaryListSchema.parse(await this.request('listRecords', { sessionKey }));
  }

  public async getRecord(sessionKey: string, id: number): Promise<ThoughtRecord | null> {
    const result = await this.request('getRecord', { id, sessionKey });
    if (result === null) {
      return null;
    }
    if (!isThoughtRecord(result)) {
      throw new Error('Thought Store returned an invalid record');
    }
    return result;
  }

  public async endSession(sessionKey: string): Promise<number> {
    const affected = Number(await this.request('end', { sessionKey }));
    this.sessions.delete(sessionKey);
    return affected;
  }

  public async deleteSession(sessionKey: string): Promise<number> {
    const affected = Number(await this.request('deleteSession', { sessionKey }));
    this.sessions.delete(sessionKey);
    return affected;
  }

  public async clear(): Promise<number> {
    const affected = Number(await this.request('clear', null));
    this.sessions.clear();
    return affected;
  }

  public async stats(): Promise<ThoughtStoreStats> {
    const persisted = ThoughtStoreStatsSchema.pick({ databaseBytes: true, sessions: true }).parse(
      await this.request('stats', null),
    );
    const queue = this.ensureWorker().getStats();
    return ThoughtStoreStatsSchema.parse({
      ...persisted,
      memorySessions: this.sessions.size,
      workerAlive: queue.alive,
      workerPendingBytes: queue.pendingBytes,
      workerPendingCommands: queue.pendingCommands,
      writeFailures: this.writeFailures,
    });
  }

  public async configure(config: ThoughtStoreConfig): Promise<void> {
    await this.request('cleanup', {
      maxSessions: config.max_sessions,
      retentionDays: config.retention_days,
    });
    for (const [sessionKey, session] of this.sessions) {
      this.pruneMemorySession(sessionKey, session, config);
    }
    this.pruneMemorySessions(config.max_sessions);
  }

  public async repair(): Promise<DatabaseRepairResult> {
    if (this.repairInProgress) {
      return this.repairInProgress;
    }
    const repair = this.performRepair().finally(() => {
      this.repairInProgress = null;
    });
    this.repairInProgress = repair;
    return repair;
  }

  public async close(): Promise<void> {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await worker.close();
    }
    this.sessions.clear();
    this.hydration.clear();
  }

  private ingestContents(
    sessionKey: string,
    contents: GeminiContent[],
    model: string,
    historical = false,
  ): void {
    const incoming = contents
      .map((content) => extractThoughtRecord(content, model))
      .filter((record): record is ThoughtRecordInput => record !== null);
    if (!historical) {
      for (const record of incoming) {
        this.storeRecord(sessionKey, record);
      }
      return;
    }
    if (incoming.length === 0) {
      return;
    }

    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }
    const existing = [...session.records];
    const used = new Set<number>();
    const upgrades: Array<{ index: number; record: ThoughtRecordInput }> = [];
    const toAppend: ThoughtRecordInput[] = [];
    for (const record of incoming) {
      const index = findExistingThoughtRecordIndex(record, existing, used);
      if (index === null) {
        toAppend.push(record);
        continue;
      }
      used.add(index);
      if (isStrongerThoughtRecord(record, existing[index])) {
        upgrades.push({ index, record });
      }
    }
    if (upgrades.length === 0 && toAppend.length === 0) {
      return;
    }

    const config = this.getConfig();
    const { maxBytes, maxTurns } = resolveThoughtSessionLimits(config);
    const now = Date.now();
    for (const { index, record } of upgrades) {
      const previous = existing[index];
      const currentIndex = session.records.findIndex((item) => item.id === previous.id);
      if (currentIndex >= 0) {
        session.records[currentIndex] = toMemoryRecord(record, previous.id, now, maxBytes);
      }
    }
    this.pruneMemorySession(sessionKey, session, config);
    for (const record of toAppend) {
      this.storeRecord(sessionKey, record, false);
    }

    if (this.repairInProgress) {
      this.writeFailures += 1;
      return;
    }
    const accepted = this.tryWrite('ingestHistory', {
      records: incoming.map((record) => ({
        ...record,
        createdAt: now,
        maxSessionBytes: maxBytes,
        maxSessions: config.max_sessions,
        maxTurns,
        meaningful: isMeaningfulThought(record.thought),
        sessionKey,
      })),
      sessionKey,
    });
    if (!accepted) {
      this.writeFailures += 1;
    }
  }

  private restoreContents(sessionKey: string, contents: GeminiContent[], model: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session || session.records.length === 0) {
      return;
    }
    session.lastAccessed = Date.now();
    this.touchSession(sessionKey);
    restoreStoredThoughts(contents, session.records, model);
  }

  private storeRecord(sessionKey: string, input: ThoughtRecordInput, persist = true): void {
    const config = this.getConfig();
    const now = Date.now();
    const session = this.sessions.get(sessionKey) ?? {
      lastAccessed: now,
      loaded: true,
      records: [],
    };
    const { maxBytes, maxTurns } = resolveThoughtSessionLimits(config);
    const incoming = toMemoryRecord(input, `memory-${randomUUID()}`, now, maxBytes);

    const latest = session.records.at(-1);
    if (latest && recordsIdentifySameTurn(latest, incoming)) {
      const preserveThought =
        !isMeaningfulThought(input.thought) && isMeaningfulThought(latest.thought);
      session.records[session.records.length - 1] = {
        ...latest,
        ...incoming,
        id: latest.id,
        signature: incoming.signature ?? latest.signature,
        thought: preserveThought ? latest.thought : incoming.thought,
      };
    } else {
      session.records.push(incoming);
    }
    session.lastAccessed = now;
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, session);
    this.pruneMemorySession(sessionKey, session, config);
    this.pruneMemorySessions(config.max_sessions);

    if (!persist) {
      return;
    }
    if (this.repairInProgress) {
      this.writeFailures += 1;
      return;
    }
    const accepted = this.tryWrite('save', {
      ...input,
      createdAt: now,
      maxSessionBytes: maxBytes,
      maxSessions: config.max_sessions,
      maxTurns,
      meaningful: isMeaningfulThought(input.thought),
      sessionKey,
    });
    if (!accepted) {
      this.writeFailures += 1;
    }
  }

  private async ensureHydrated(sessionKey: string): Promise<ThoughtRecord[]> {
    const existing = this.sessions.get(sessionKey);
    if (existing?.loaded) {
      existing.lastAccessed = Date.now();
      return existing.records;
    }
    const inFlight = this.hydration.get(sessionKey);
    if (inFlight) {
      return inFlight;
    }

    const load = this.request('load', { sessionKey })
      .then((value) => {
        const records = parseThoughtRecords(value);
        const session = { lastAccessed: Date.now(), loaded: true, records };
        this.pruneMemorySession(sessionKey, session, this.getConfig());
        this.sessions.set(sessionKey, session);
        this.pruneMemorySessions(this.getConfig().max_sessions);
        return records;
      })
      .catch((error) => {
        this.writeFailures += 1;
        logger.warn('Thought Store hydration failed; continuing without restore', error);
        this.sessions.set(sessionKey, { lastAccessed: Date.now(), loaded: true, records: [] });
        return [];
      })
      .finally(() => this.hydration.delete(sessionKey));
    this.hydration.set(sessionKey, load);
    return load;
  }

  private touchSession(sessionKey: string): void {
    if (this.repairInProgress) {
      this.writeFailures += 1;
      return;
    }
    if (!this.tryWrite('touch', { sessionKey })) {
      this.writeFailures += 1;
    }
  }

  private pruneMemorySession(
    _sessionKey: string,
    session: MemorySession,
    config: ThoughtStoreConfig,
  ): void {
    enforceThoughtSessionLimits(session.records, config);
  }

  private pruneMemorySessions(maxSessions: number): void {
    while (this.sessions.size > maxSessions) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, session] of this.sessions) {
        if (session.lastAccessed < oldestAt) {
          oldestAt = session.lastAccessed;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        return;
      }
      this.sessions.delete(oldestKey);
    }
  }

  private ensureWorker(): BoundedSqliteWorker {
    if (this.worker) {
      return this.worker;
    }
    const stateDir = getProxyStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    this.worker = new BoundedSqliteWorker({
      databasePath: path.join(stateDir, THOUGHT_STORE_FILENAME),
      maxPendingBytes: MAX_QUEUE_BYTES,
      maxPendingCommands: MAX_QUEUE_COMMANDS,
      name: 'thought-store-sqlite',
      onWriteFailure: (error) => {
        this.writeFailures += 1;
        logger.warn('Thought Store worker write failed', error);
      },
      workerPath: path.join(__dirname, 'thought-store.worker.js'),
    });
    this.worker.start();
    this.scheduleMaintenance();
    return this.worker;
  }

  private scheduleMaintenance(): void {
    if (this.maintenanceTimer) {
      return;
    }
    this.maintenanceTimer = setInterval(() => {
      const config = this.getConfig();
      this.request('cleanup', {
        maxSessions: config.max_sessions,
        retentionDays: config.retention_days,
      }).catch((error) => logger.warn('Thought Store maintenance failed', error));
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
  }

  private tryWrite<TOperation extends ThoughtStoreWorkerCommand['operation']>(
    operation: TOperation,
    payload: Extract<ThoughtStoreWorkerCommand, { operation: TOperation }>['payload'],
  ): boolean {
    return this.ensureWorker().tryWrite({ operation, payload });
  }

  private async request<
    TOperation extends ThoughtStoreWorkerCommand['operation'],
    TResult = unknown,
  >(
    operation: TOperation,
    payload: Extract<ThoughtStoreWorkerCommand, { operation: TOperation }>['payload'],
  ): Promise<TResult> {
    if (this.repairInProgress) {
      await this.repairInProgress;
    }
    return this.ensureWorker().request<TResult>({ operation, payload });
  }

  private async performRepair(): Promise<DatabaseRepairResult> {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await worker.close();
    }
    this.sessions.clear();
    this.hydration.clear();

    const databasePath = path.join(getProxyStateDir(), THOUGHT_STORE_FILENAME);
    const backupPath = preserveCorruptSqliteDatabase(databasePath);
    await this.ensureWorker().request({ operation: 'stats', payload: null });
    return { backupPath, repaired: true };
  }

  private getConfig(): ThoughtStoreConfig {
    return getServerConfig()?.thought_store ?? DEFAULT_APP_CONFIG.proxy.thought_store;
  }
}

export const thoughtStoreService = new ThoughtStoreService();

export function isPlaceholderThought(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (
    normalized === '...' ||
    normalized === '.' ||
    normalized === '·' ||
    normalized === '···' ||
    normalized === '[undefined]' ||
    normalized === 'applying tool decisions and generating response...'
  ) {
    return true;
  }
  return /^[.·…]+$/u.test(normalized);
}

function extractThoughtRecord(
  content: GeminiContent,
  model: string,
  allowProbe = false,
): ThoughtRecordInput | null {
  if (!isAssistantRole(content)) {
    return null;
  }
  const parts = getParts(content);
  if (!parts) {
    return null;
  }
  const thought: string[] = [];
  const visible: string[] = [];
  const toolIds: string[] = [];
  const toolNames: string[] = [];
  let signature: string | null = null;

  for (const value of parts) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const part = value as Record<string, unknown>;
    const text = typeof part.text === 'string' ? part.text : '';
    if (part.thought === true) {
      if (text) {
        thought.push(text);
      }
    } else if (text) {
      visible.push(text);
    }
    const partSignature = readSignature(part);
    if (partSignature && (!signature || partSignature.length > signature.length)) {
      signature = partSignature;
    }
    collectToolIdentity(part.functionCall, toolIds, toolNames);
    collectToolIdentity(part.functionResponse, toolIds, toolNames);
  }

  const thoughtText = thought.join('');
  if (!allowProbe && !thoughtText && !signature) {
    return null;
  }
  if (allowProbe && !thoughtText && toolIds.length === 0 && visible.length === 0) {
    return null;
  }
  const normalizedVisible = normalizeVisible(visible.join('\n'));
  return {
    fingerprint: fingerprint(normalizedVisible, toolIds, toolNames),
    model: model || null,
    signature,
    sourceFamily: modelFamily(model),
    thought: thoughtText,
    toolIds: unique(toolIds),
    toolNames: unique(toolNames),
    visible: normalizedVisible,
  };
}

function getParts(content: GeminiContent): Array<Record<string, unknown>> | null {
  const parts = Reflect.get(content, 'parts');
  return Array.isArray(parts) ? (parts as Array<Record<string, unknown>>) : null;
}

function isAssistantRole(content: GeminiContent): boolean {
  const role = Reflect.get(content, 'role');
  return role === 'model' || role === 'assistant';
}

function readSignature(part: Record<string, unknown>): string | null {
  const value = part.thoughtSignature ?? part.thought_signature;
  return typeof value === 'string' &&
    value.length >= MIN_REAL_SIGNATURE_LENGTH &&
    value !== PLACEHOLDER_SIGNATURE
    ? value
    : null;
}

function collectToolIdentity(value: unknown, ids: string[], names: string[]): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  const id = Reflect.get(value, 'id');
  const name = Reflect.get(value, 'name');
  if (typeof id === 'string' && id) {
    ids.push(id);
  }
  if (typeof name === 'string' && name) {
    names.push(name);
  }
}

interface RestorableTurn {
  parts: Array<Record<string, unknown>>;
  probe: ThoughtRecordInput;
  complete: boolean;
  matchedIndex: number | null;
}

/** Match newest turns first; only the final model turn may use a category-only fallback. */
export function restoreStoredThoughts(
  contents: GeminiContent[],
  records: readonly ThoughtRecord[],
  model: string,
): number {
  const available = records.filter((record) => modelsCompatible(record, model));
  const turns: RestorableTurn[] = [];
  for (const content of contents) {
    const parts = getParts(content);
    if (!parts || !isAssistantRole(content)) {
      continue;
    }
    const probe = extractThoughtRecord(content, model, true);
    if (probe) {
      turns.push({
        complete: !turnNeedsRestore(parts),
        matchedIndex: null,
        parts,
        probe,
      });
    }
  }

  const used = new Set<number>();
  const match = (turn: RestorableTurn, predicate: (record: ThoughtRecord) => boolean): void => {
    for (let index = available.length - 1; index >= 0; index--) {
      if (!used.has(index) && predicate(available[index])) {
        turn.matchedIndex = index;
        used.add(index);
        return;
      }
    }
  };

  for (const turn of [...turns].reverse()) {
    if (!turn.complete && turn.probe.toolIds.length > 0) {
      match(turn, (record) => turn.probe.toolIds.some((toolId) => record.toolIds.includes(toolId)));
    }
  }
  for (const turn of [...turns].reverse()) {
    if (!turn.complete && turn.matchedIndex === null) {
      match(
        turn,
        (record) =>
          record.fingerprint === turn.probe.fingerprint &&
          hasThoughtTools(record) === hasThoughtTools(turn.probe),
      );
    }
  }
  for (const turn of [...turns].reverse()) {
    if (
      turn.complete ||
      turn.matchedIndex !== null ||
      hasThoughtTools(turn.probe) ||
      !turn.probe.visible
    ) {
      continue;
    }
    match(turn, (record) => {
      if (hasThoughtTools(record) || !record.visible) {
        return false;
      }
      return (
        record.visible === turn.probe.visible ||
        record.visible.startsWith(turn.probe.visible) ||
        turn.probe.visible.startsWith(record.visible)
      );
    });
  }
  const lastTurn = turns.at(-1);
  if (lastTurn && !lastTurn.complete && lastTurn.matchedIndex === null) {
    match(lastTurn, (record) => hasThoughtTools(record) === hasThoughtTools(lastTurn.probe));
  }

  let restored = 0;
  for (const turn of turns) {
    if (turn.complete || turn.matchedIndex === null) {
      continue;
    }
    const record = available[turn.matchedIndex];
    if ((record.thought.trim() || record.signature) && restoreRecordIntoParts(turn.parts, record)) {
      restored += 1;
    }
  }
  return restored;
}

function turnNeedsRestore(parts: Array<Record<string, unknown>>): boolean {
  const thought = parts
    .filter((part) => part.thought === true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  if (isPlaceholderThought(thought)) {
    return true;
  }
  for (const part of parts) {
    if (part.functionCall && !readSignature(part)) {
      return true;
    }
  }
  return !parts.some((part) => readSignature(part));
}

function restoreRecordIntoParts(
  parts: Array<Record<string, unknown>>,
  record: ThoughtRecord,
): boolean {
  const existingThought = parts
    .filter((part) => part.thought === true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  const hasUnvalidatedFunctionCall = parts.some(
    (part) => part.functionCall && !readSignature(part),
  );
  const shouldReplace =
    isPlaceholderThought(existingThought) ||
    Buffer.byteLength(existingThought, 'utf8') < Buffer.byteLength(record.thought, 'utf8') ||
    (Boolean(record.signature) && !parts.some((part) => readSignature(part))) ||
    hasUnvalidatedFunctionCall;
  if (!shouldReplace) {
    return false;
  }

  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].thought === true) {
      parts.splice(index, 1);
    }
  }
  const signature = record.signature ?? PLACEHOLDER_SIGNATURE;
  const thoughtPart: Record<string, unknown> = {
    text: isPlaceholderThought(record.thought) ? '...' : record.thought,
    thought: true,
    thoughtSignature: signature,
  };
  for (const part of parts) {
    if (part.functionCall && (record.signature || !readSignature(part))) {
      part.thoughtSignature = signature;
    }
  }
  parts.unshift(thoughtPart);
  return true;
}

function toMemoryRecord(
  input: ThoughtRecordInput,
  id: ThoughtRecord['id'],
  createdAt: number,
  maxBytes: number,
): ThoughtRecord {
  const rawBytes = Buffer.byteLength(input.thought, 'utf8');
  const oversized = rawBytes > maxBytes;
  return {
    ...input,
    createdAt,
    id,
    oversized,
    oversizedBytes: oversized ? rawBytes : null,
    oversizedSha256: oversized ? sha256Hex(input.thought) : null,
    thought: oversized ? '' : input.thought,
  };
}

function recordsIdentifySameTurn(left: ThoughtRecord, right: ThoughtRecord): boolean {
  if (right.toolIds.length > 0) {
    return right.toolIds.some((id) => left.toolIds.includes(id));
  }
  return left.toolIds.length === 0 && left.fingerprint === right.fingerprint;
}

function isMeaningfulThought(value: string): boolean {
  return Boolean(value.trim()) && !isPlaceholderThought(value);
}

function modelsCompatible(record: ThoughtRecord, model: string): boolean {
  const family = modelFamily(model);
  return !record.sourceFamily || !family || record.sourceFamily === family;
}

function modelFamily(model: string): string | null {
  const normalized = model.toLowerCase().replace(/^models\//u, '');
  if (!normalized) {
    return null;
  }
  if (normalized.includes('gemini-3')) {
    return 'gemini-3';
  }
  if (normalized.includes('gemini-2')) {
    return 'gemini-2';
  }
  if (normalized.includes('claude')) {
    return 'claude';
  }
  return normalized.split(/[-:]/u).slice(0, 2).join('-');
}

function normalizeVisible(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function fingerprint(visible: string, toolIds: string[], toolNames: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([visible, unique(toolIds), unique(toolNames)]), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function responseToContents(response: unknown): GeminiContent[] {
  if (!response || typeof response !== 'object') {
    return [];
  }
  const wrapped = Reflect.get(response, 'response');
  const source = wrapped && typeof wrapped === 'object' ? wrapped : response;
  const candidates = Reflect.get(source, 'candidates');
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates
    .map((candidate) =>
      candidate && typeof candidate === 'object' ? Reflect.get(candidate, 'content') : null,
    )
    .filter((content): content is GeminiContent => Boolean(content && typeof content === 'object'));
}

function parseThoughtRecords(value: unknown): ThoughtRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('Thought Store returned an invalid record list');
  }
  return value.filter(isThoughtRecord);
}

function isThoughtRecord(value: unknown): value is ThoughtRecord {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (typeof Reflect.get(value, 'id') === 'number' ||
      typeof Reflect.get(value, 'id') === 'string') &&
    typeof Reflect.get(value, 'fingerprint') === 'string' &&
    typeof Reflect.get(value, 'thought') === 'string' &&
    Array.isArray(Reflect.get(value, 'toolIds')) &&
    Array.isArray(Reflect.get(value, 'toolNames')) &&
    typeof Reflect.get(value, 'visible') === 'string' &&
    typeof Reflect.get(value, 'createdAt') === 'number',
  );
}
