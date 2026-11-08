import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  discoverClaudeCoworkRuntimes, inspectClaudeCoworkRuntime, previewClaudeCoworkPatch,
  type ClaudeCoworkRuntimeCandidate,
} from '../binary-patch/claudeCoworkRuntime';
import {
  CoworkOperationError, type CoworkPreview, type CoworkTarget, type CoworkReceipt,
  type VerifiedCoworkSource, type CoworkLifecycleResult,
} from './contracts';
import {
  CoworkBackupStore, isInterruptedCoworkJournal, readCoworkSource, sourceHash,
} from './storage';
import {
  coworkFailureCode, executeCoworkTransaction, failedCoworkReceipt, requireStopped,
  type CoworkPreparedOperation,
} from './transaction';

interface Selection {
  candidate: ClaudeCoworkRuntimeCandidate;
  prepared: { id: string; operation: CoworkPreparedOperation } | null;
}

export interface CoworkRuntimeServiceOptions {
  backupRoot: string;
  platform?: NodeJS.Platform;
  /** A product/package recipe must prove identity and exact-instance lifecycle ownership. */
  resolveVerifiedSource?: (
    candidate: ClaudeCoworkRuntimeCandidate,
  ) => Promise<VerifiedCoworkSource | null>;
}

export class CoworkRuntimeService {
  private readonly selections = new Map<string, Selection>();
  private readonly activeTargets = new Set<string>();
  private readonly store: CoworkBackupStore;
  private readonly platform: NodeJS.Platform;
  private lastFailure: Error | null = null;

  constructor(private readonly options: CoworkRuntimeServiceOptions) {
    this.store = new CoworkBackupStore(options.backupRoot);
    this.platform = options.platform ?? process.platform;
  }

  /** Kept in main for diagnosis. Raw filesystem/process causes never cross IPC. */
  getLastFailure(): Error | null {
    return this.lastFailure;
  }

  async discover(customPath?: string): Promise<CoworkTarget[]> {
    const roots = this.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'Claude-3p', 'claude-code'), '/Applications']
      : [];
    const candidates = discoverClaudeCoworkRuntimes({
      roots, customPath, maxDepth: 4, maxCandidates: 32, maxFileBytes: 1024 * 1024,
    });
    const result: CoworkTarget[] = [];
    for (const candidate of candidates) {
      const selectionId = randomUUID();
      this.selections.set(selectionId, { candidate, prepared: null });
      while (this.selections.size > 32) {
        const oldest = this.selections.keys().next().value;
        if (oldest) {
          this.selections.delete(oldest);
        }
      }
      result.push(await this.inspect(selectionId));
    }
    return result;
  }

  private selection(selectionId: string): Selection {
    const selection = this.selections.get(selectionId);
    if (!selection) {
      throw new CoworkOperationError('selection-expired');
    }
    return selection;
  }

  private async admission(
    candidate: ClaudeCoworkRuntimeCandidate,
    state: CoworkTarget['state'],
  ): Promise<VerifiedCoworkSource | null> {
    if (state === 'unreadable' || state === 'unsupported' || state === 'ambiguous') {
      return null;
    }
    if (this.platform === 'win32' || candidate.canonicalPath.split(path.sep).some((part) => part.endsWith('.app'))) {
      return null;
    }
    const verified = await this.options.resolveVerifiedSource?.(candidate);
    if (!verified) {
      return null;
    }
    if (verified.canonicalPath !== candidate.canonicalPath || !verified.version || !verified.packageId) {
      throw new CoworkOperationError('unsupported-target');
    }
    await verified.verifyOwnership();
    return verified;
  }

  async inspect(selectionId: string): Promise<CoworkTarget> {
    const selection = this.selection(selectionId);
    const status = inspectClaudeCoworkRuntime(selection.candidate);
    const verified = await this.admission(selection.candidate, status.state);
    const code = this.platform === 'win32' ? 'windows-recipe-unverified'
      : selection.candidate.canonicalPath.split(path.sep).some((part) => part.endsWith('.app'))
        ? 'bundle-recovery-unverified'
        : status.state === 'unsupported' ? 'native-payload-unverified' : 'package-ownership-unverified';
    const journal = verified ? this.store.readJournal(selection.candidate.canonicalPath) : null;
    return {
      selectionId, candidate: selection.candidate, state: status.state,
      matchedFunctions: status.matchedFunctions,
      ...(status.nativePayload ? { nativePayload: status.nativePayload } : {}),
      eligibility: verified ? { kind: 'eligible', packageId: verified.packageId, version: verified.version }
        : { kind: 'unsupported', code },
      recovery: !verified ? 'not-inspected' : !journal ? 'none'
        : isInterruptedCoworkJournal(journal) ? 'interrupted' : 'available',
    };
  }

  async preview(selectionId: string, action: 'apply' | 'restore'): Promise<CoworkPreview> {
    const selection = this.selection(selectionId);
    selection.prepared = null;
    const target = await this.inspect(selectionId);
    const result: CoworkPreview = {
      selectionId, previewId: null, action, state: 'unavailable', target,
      beforeSha256: selection.candidate.sha256, afterSha256: null, byteRange: null,
      backupId: null, signature: 'unsupported', lifecycle: 'unsupported',
    };
    if (target.state === 'unreadable' || target.state === 'unsupported' || target.state === 'ambiguous') {
      return result;
    }
    const before = readCoworkSource(selection.candidate.canonicalPath);
    if (sourceHash(before) !== selection.candidate.sha256) {
      throw new CoworkOperationError('stale-target');
    }
    const verified = await this.admission(selection.candidate, target.state);
    if (action === 'apply') {
      if (target.recovery === 'interrupted') {
        throw new CoworkOperationError('recovery-required');
      }
      const preview = previewClaudeCoworkPatch(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before));
      if (preview.state !== 'ready') {
        result.state = preview.plan.state === 'already-current' ? 'already-current' : 'unavailable';
        return result;
      }
      result.afterSha256 = preview.patchedSha256;
      result.byteRange = preview.byteRange;
      result.state = 'inspection-only';
      if (!verified) {
        return result;
      }
      const operation: CoworkPreparedOperation = {
        action, source: verified, before, beforeMode: fs.statSync(verified.canonicalPath).mode,
        after: Buffer.from(preview.patchedSource),
        journal: {
          format: 1, targetPath: verified.canonicalPath, packageId: verified.packageId,
          version: verified.version, originalSha256: preview.originalSha256,
          patchedSha256: preview.patchedSha256, mode: fs.statSync(verified.canonicalPath).mode,
          phase: 'prepared',
        },
      };
      selection.prepared = { id: randomUUID(), operation };
    } else {
      if (!verified) {
        return result;
      }
      const journal = this.store.readJournal(verified.canonicalPath);
      if (!journal || journal.packageId !== verified.packageId || journal.version !== verified.version) {
        throw new CoworkOperationError('backup-invalid');
      }
      const after = this.store.original(journal);
      const preview = previewClaudeCoworkPatch(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(after));
      if (preview.state !== 'ready' || preview.originalSha256 !== journal.originalSha256 ||
        preview.patchedSha256 !== journal.patchedSha256) {
        throw new CoworkOperationError('backup-invalid');
      }
      if (!before.equals(after) && !before.equals(Buffer.from(preview.patchedSource))) {
        throw new CoworkOperationError('stale-target');
      }
      result.afterSha256 = journal.originalSha256;
      result.backupId = journal.originalSha256;
      selection.prepared = { id: randomUUID(), operation: {
        action, source: verified, before, beforeMode: fs.statSync(verified.canonicalPath).mode, after, journal,
      } };
    }
    result.state = 'ready';
    result.previewId = selection.prepared.id;
    result.signature = 'not-required';
    result.lifecycle = 'selected-instance';
    return result;
  }

  async operate(input: { selectionId: string; previewId: string; restart: boolean }, action: 'apply' | 'restore'): Promise<CoworkReceipt> {
    try {
      const selection = this.selection(input.selectionId);
      const prepared = selection.prepared;
      if (!prepared || prepared.id !== input.previewId || prepared.operation.action !== action) {
        return failedCoworkReceipt(action, 'unavailable-preview');
      }
      const targetPath = prepared.operation.source.canonicalPath;
      if (this.activeTargets.has(targetPath)) {
        return failedCoworkReceipt(action, 'busy');
      }
      this.activeTargets.add(targetPath);
      selection.prepared = null;
      try {
        const result = await executeCoworkTransaction(prepared.operation, this.store, input.restart);
        this.lastFailure = result.failure;
        return result.receipt;
      } finally {
        this.activeTargets.delete(targetPath);
      }
    } catch (error) {
      this.lastFailure = error instanceof Error ? error : new Error('Cowork operation failed');
      return failedCoworkReceipt(action, coworkFailureCode(error));
    }
  }

  async lifecycle(selectionId: string, action: 'inspect' | 'stop' | 'start'): Promise<CoworkLifecycleResult> {
    const selection = this.selection(selectionId);
    const status = inspectClaudeCoworkRuntime(selection.candidate);
    const source = await this.admission(selection.candidate, status.state);
    if (!source) {
      return { selectionId, state: 'unsupported', code: 'unsupported-target' };
    }
    if (this.activeTargets.has(source.canonicalPath)) {
      return { selectionId, state: 'unknown', code: 'busy' };
    }
    this.activeTargets.add(source.canonicalPath);
    try {
      if (sourceHash(readCoworkSource(source.canonicalPath)) !== selection.candidate.sha256) {
        throw new CoworkOperationError('stale-target');
      }
      const state = await source.lifecycle.inspect();
      if (action === 'inspect') {
        return { selectionId, state, code: state === 'unknown' ? 'process-state-unknown' : null };
      }
      if (action === 'stop') {
        await requireStopped(source);
        return { selectionId, state: 'stopped', code: null };
      }
      if (state === 'unknown') {
        throw new CoworkOperationError('process-state-unknown');
      }
      if (state !== 'running') {
        await source.verifyOwnership();
        if (sourceHash(readCoworkSource(source.canonicalPath)) !== selection.candidate.sha256) {
          throw new CoworkOperationError('stale-target');
        }
        const journal = this.store.readJournal(source.canonicalPath);
        if (journal && isInterruptedCoworkJournal(journal)) {
          throw new CoworkOperationError('recovery-required');
        }
        await source.lifecycle.start();
      }
      if (await source.lifecycle.inspect() !== 'running') {
        throw new CoworkOperationError('lifecycle-failed');
      }
      return { selectionId, state: 'running', code: null };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error : new Error('Cowork lifecycle failed');
      return { selectionId, state: 'unknown', code: coworkFailureCode(error) };
    } finally {
      this.activeTargets.delete(source.canonicalPath);
    }
  }
}
