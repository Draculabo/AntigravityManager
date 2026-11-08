import { isPlaceholderThought } from './thought-placeholder';
export { isPlaceholderThought } from './thought-placeholder';
import { createHash } from 'node:crypto';
import type { GeminiContent } from '../antigravity/types';
import type { ThoughtRecord, ThoughtRecordInput } from './thought-store.types';
import { areThoughtRecordModelsCompatible } from './thought-store.model';
import { findExistingThoughtRecordIndex } from './thought-store.matching';
import {
  readThoughtPartSignature as readSignature,
  thoughtToolIdentity,
  sameThoughtTool,
  thoughtSignaturesOf,
  signaturesEquivalent,
  type ThoughtPartSignature,
} from './thought-part-signatures';
export function extractThoughtRecord(
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
  const partSignatures: ThoughtPartSignature[] = [];
  let thoughtLength = 0;

  for (const [position, value] of parts.entries()) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const part = value as Record<string, unknown>;
    const text = typeof part.text === 'string' ? part.text : '';
    const partSignature = readSignature(part);
    if (part.thought === true) {
      thought.push(text);
      partSignatures.push({
        kind: 'thought',
        position,
        start: thoughtLength,
        end: thoughtLength + text.length,
        signature: partSignature,
      });
      thoughtLength += text.length;
    } else if (text) {
      visible.push(text);
    }
    const tool = thoughtToolIdentity(part.functionCall);
    if (tool) {
      partSignatures.push({ ...tool, kind: 'tool', position, signature: partSignature });
    }
    collectToolIdentity(part.functionCall, toolIds, toolNames);
    collectToolIdentity(part.functionResponse, toolIds, toolNames);
  }

  const thoughtText = thought.join('');
  const reasoningSignatures = partSignatures
    .filter((part) => part.kind === 'thought' && part.signature)
    .map((part) => part.signature);
  const signature =
    reasoningSignatures.length > 0 &&
    reasoningSignatures.every((value) => signaturesEquivalent(value, reasoningSignatures[0]))
      ? reasoningSignatures[0]
      : null;
  if (
    !allowProbe &&
    !isMeaningfulThought(thoughtText) &&
    !partSignatures.some((part) => part.signature)
  ) {
    return null;
  }
  if (
    allowProbe &&
    !thoughtText &&
    toolNames.length === 0 &&
    visible.length === 0 &&
    !partSignatures.some((part) => part.signature)
  ) {
    return null;
  }
  const normalizedVisible = normalizeVisible(visible.join('\n'));
  return {
    fingerprint: fingerprint(normalizedVisible, toolIds, toolNames),
    model: model || null,
    signature,
    partSignatures,
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

export type ThoughtContentRestoreOutcome =
  | { kind: 'restored'; record: ThoughtRecord }
  | { kind: 'no-candidate' }
  | { kind: 'unresolved' }
  | { kind: 'matched-unchanged' };

/** Restore only uniquely identified records; similarity and array order are not ownership. */
export function restoreStoredThoughts(
  contents: GeminiContent[],
  records: readonly ThoughtRecord[],
  model: string,
  causalAnchors?: readonly string[],
  onOutcome?: (outcome: ThoughtContentRestoreOutcome) => void,
): number {
  const available = records.filter((record) => areThoughtRecordModelsCompatible(record, { model }));
  const turns: RestorableTurn[] = [];
  for (const [contentIndex, content] of contents.entries()) {
    const parts = getParts(content);
    if (!parts || !isAssistantRole(content)) {
      continue;
    }
    const probe = extractThoughtRecord(content, model, true);
    if (probe) {
      if (causalAnchors) { probe.causalAnchor = causalAnchors[contentIndex]; }
      turns.push({
        complete: !turnNeedsRestore(parts),
        matchedIndex: null,
        parts,
        probe,
      });
    }
  }

  const used = new Set<number>();
  // Reserve explicit signatures before weaker evidence, including already complete turns.
  for (const signed of [true, false]) {
    const proposals = turns
      .filter((turn) => thoughtSignaturesOf(turn.probe).length > 0 === signed)
      .map((turn) => ({
        index: findExistingThoughtRecordIndex(turn.probe, available, used, 'restore'),
        turn,
      }));
    const claims = new Map<number, number>();
    for (const { index } of proposals) {
      if (index !== null) {
        claims.set(index, (claims.get(index) ?? 0) + 1);
      }
    }
    for (const { index, turn } of proposals) {
      if (index !== null && claims.get(index) === 1) {
        turn.matchedIndex = index;
        used.add(index);
      }
    }
  }

  let restored = 0;
  for (const turn of turns) {
    if (turn.complete) {
      continue;
    }
    if (turn.matchedIndex === null) {
      // The matcher also returns null for ambiguity and competing ownership claims.
      onOutcome?.({ kind: available.length === 0 ? 'no-candidate' : 'unresolved' });
      continue;
    }
    const record = available[turn.matchedIndex];
    if (restoreRecordIntoParts(turn.parts, record)) {
      restored += 1;
      onOutcome?.({ kind: 'restored', record });
    } else {
      onOutcome?.({ kind: 'matched-unchanged' });
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
    if ((part.functionCall || part.thought === true) && !readSignature(part)) {
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
  let changed = false;
  const tools = record.partSignatures.filter((part) => part.kind === 'tool');
  const current = parts.flatMap((part) => {
    const identity = thoughtToolIdentity(part.functionCall);
    return identity ? [{ part, identity }] : [];
  });
  for (const { part, identity } of current) {
    if (readSignature(part)) {
      continue;
    }
    const matches = tools.filter((tool) => sameThoughtTool(tool, identity));
    const claims = current.filter((candidate) => sameThoughtTool(candidate.identity, identity));
    if (matches.length === 1 && claims.length === 1 && matches[0].signature) {
      delete part.thought_signature;
      part.thoughtSignature = matches[0].signature;
      changed = true;
    }
  }
  const reasoning = record.partSignatures.filter((part) => part.kind === 'thought');
  const supplied = parts.filter((part) => part.thought === true);
  // Every supplied signed block must match exactly one stored range before any
  // cache text replacement; this also protects signed whitespace and placeholders.
  const signedBlocks = supplied.filter((part) => readSignature(part));
  const signedBlocksOwned = signedBlocks.every((part) => {
    const text = typeof part.text === 'string' ? part.text : '';
    const matches = reasoning.filter(
      (entry) =>
        record.thought.slice(entry.start, entry.end) === text &&
        signaturesEquivalent(readSignature(part), entry.signature),
    );
    const claims = reasoning.filter(
      (entry) => record.thought.slice(entry.start, entry.end) === text,
    );
    if (matches.length === 1 && claims.length === 1) {
      return true;
    }
    // An explicit ellipsis is a recovery marker, not signed reasoning text. Its
    // signature may identify one stored block. Whitespace and empty text remain
    // client-owned byte for byte.
    const isMarker = text.length > 0 && text === text.trim() && isPlaceholderThought(text);
    if (!isMarker) {
      return false;
    }
    return (
      reasoning.filter((entry) => signaturesEquivalent(readSignature(part), entry.signature))
        .length === 1
    );
  });
  if (record.oversized || reasoning.length === 0 || !signedBlocksOwned) {
    return changed;
  }
  if (
    !isPlaceholderThought(existingThought) &&
    existingThought !== record.thought &&
    Buffer.byteLength(existingThought, 'utf8') >= Buffer.byteLength(record.thought, 'utf8')
  ) {
    return changed;
  }
  // Reconstruct text ranges atomically; explicit signatures must agree with the
  // corresponding exact text. Repeated identical signed ranges remain ambiguous.
  const replacements = reasoning.map((entry) => {
    const text = record.thought.slice(entry.start, entry.end);
    const candidates = supplied.filter((part) => part.text === text && readSignature(part));
    const sourceClaims = reasoning.filter(
      (other) => record.thought.slice(other.start, other.end) === text,
    );
    if (
      candidates.length > 1 ||
      (candidates.length > 0 && sourceClaims.length > 1) ||
      (candidates[0] && !signaturesEquivalent(readSignature(candidates[0]), entry.signature))
    ) {
      return null;
    }
    return {
      entry,
      part: candidates[0] ?? {
        thought: true,
        text,
        ...(entry.signature ? { thoughtSignature: entry.signature } : {}),
      },
    };
  });
  if (replacements.some((part) => part === null)) {
    return changed;
  }
  const rebuilt = parts.filter((part) => part.thought !== true);
  for (const replacement of replacements) {
    if (replacement) {
      rebuilt.splice(Math.min(replacement.entry.position, rebuilt.length), 0, replacement.part);
    }
  }
  if (
    rebuilt.length !== parts.length ||
    rebuilt.some(
      (part, index) =>
        part !== parts[index] &&
        (part.thought !== parts[index]?.thought ||
          part.text !== parts[index]?.text ||
          readSignature(part) !== readSignature(parts[index])),
    )
  ) {
    parts.splice(0, parts.length, ...rebuilt);
    changed = true;
  }
  return changed;
}

export function isMeaningfulThought(value: string): boolean {
  return Boolean(value.trim()) && !isPlaceholderThought(value);
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
