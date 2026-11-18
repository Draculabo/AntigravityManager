import {
  ThoughtPartSignaturesSchema,
  type ThoughtPartSignature,
  type ThoughtToolSignature,
} from './thought-part-signatures.schema';
export {
  ThoughtPartSignaturesSchema,
  type ThoughtPartSignature,
  type ThoughtToolSignature,
} from './thought-part-signatures.schema';

import { isThoughtSignaturePlaceholder } from '../antigravity/ThoughtSignatureCompat';
import { hashSessionAnchor } from '../../../server/gateway/common/session-anchor-hash';
import { areThoughtSignaturesEquivalent } from '../antigravity/thought-signature-format';

/** Opaque values, including short ones, are retained byte for byte. */
export function readThoughtPartSignature(part: object): string | null {
  const value: unknown =
    Reflect.get(part, 'thoughtSignature') ?? Reflect.get(part, 'thought_signature');
  return typeof value === 'string' &&
    value.length > 0 &&
    !isThoughtSignaturePlaceholder(value)
    ? value
    : null;
}

export function thoughtToolIdentity(
  value: unknown,
): Omit<ThoughtToolSignature, 'kind' | 'position' | 'signature'> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const name: unknown = Reflect.get(value, 'name');
  const id: unknown = Reflect.get(value, 'id');
  const args: unknown = Reflect.get(value, 'args');
  if (typeof name !== 'string' || !name) {
    return null;
  }
  return {
    callId: typeof id === 'string' && id ? id : null,
    name,
    argsDigest: hashSessionAnchor(args ?? {}),
  };
}

/** Position is retained for layout only; it never identifies a tool's signature. */
export function sameThoughtTool(
  left: Pick<ThoughtToolSignature, 'name' | 'argsDigest' | 'callId'>,
  right: Pick<ThoughtToolSignature, 'name' | 'argsDigest' | 'callId'>,
): boolean {
  return (
    left.name === right.name &&
    left.argsDigest === right.argsDigest &&
    (!left.callId || !right.callId || left.callId === right.callId)
  );
}

export function thoughtSignaturesOf(record: {
  signature: string | null;
  partSignatures: readonly ThoughtPartSignature[];
}): string[] {
  return [record.signature, ...record.partSignatures.map((part) => part.signature)].filter(
    (value): value is string => Boolean(value) && !isThoughtSignaturePlaceholder(value),
  );
}

export function thoughtPartsBytes(parts: readonly ThoughtPartSignature[]): number {
  return Buffer.byteLength(JSON.stringify(parts), 'utf8');
}

/** Redact validation failures: Zod errors may otherwise expose opaque signatures. */
export function decodeThoughtPartSignatures(
  value: unknown,
  thought?: string,
): ThoughtPartSignature[] {
  const parsed = ThoughtPartSignaturesSchema.safeParse(value);
  const ranges = parsed.success ? parsed.data.filter((part) => part.kind === 'thought') : [];
  if (
    !parsed.success ||
    (thought !== undefined && ranges.length > 0 && ranges.at(-1)?.end !== thought.length)
  ) {
    throw new Error('Thought Store contains invalid part signature metadata');
  }
  return parsed.data;
}

export function signaturesEquivalent(left: string | null, right: string | null): boolean {
  return Boolean(left && right && areThoughtSignaturesEquivalent(left, right));
}
