import { groupBy } from 'lodash-es';
import {
  sameThoughtTool,
  type ThoughtPartSignature,
  type ThoughtToolSignature,
} from './thought-part-signatures';

function shapeKey(part: ThoughtToolSignature): string {
  return JSON.stringify([part.name, part.argsDigest]);
}

/** Replay may enrich a proven round, but an evicted signed association stays evicted. */
export function replayableToolPositions(
  previous: readonly ThoughtPartSignature[],
  incoming: readonly ThoughtPartSignature[],
  livePositions: ReadonlySet<number>,
): Set<number> {
  const before = groupBy(
    previous.filter((part) => part.kind === 'tool'),
    shapeKey,
  );
  const after = groupBy(
    incoming.filter((part) => part.kind === 'tool'),
    shapeKey,
  );
  const allowed = new Set<number>();
  for (const part of incoming) {
    if (part.kind !== 'tool' || !part.signature) {
      continue;
    }
    const sources = (before[shapeKey(part)] ?? []).filter((candidate) =>
      sameThoughtTool(part, candidate),
    );
    const claims = (after[shapeKey(part)] ?? []).filter((candidate) =>
      sameThoughtTool(part, candidate),
    );
    if (claims.length !== 1 || sources.length > 1) {
      continue;
    }
    const source = sources[0];
    if (
      source &&
      (after[shapeKey(part)] ?? []).filter((candidate) => sameThoughtTool(source, candidate))
        .length !== 1
    ) {
      continue;
    }
    if (!source?.signature || livePositions.has(source.position)) {
      allowed.add(part.position);
    }
  }
  return allowed;
}
