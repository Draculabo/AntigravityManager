function scalarBytes(value: unknown): number {
  return 8 + (typeof value === 'string' ? value.length * 2 + 32 : 0);
}

/** Scalars stay in this frame; only child objects create traversal frames/results. */
function* children(value: object): Generator<object, number> {
  let bytes = 0;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const child: unknown = value[index];
      bytes += scalarBytes(child);
      if (child !== null && typeof child === 'object') {
        yield child;
      }
    }
  } else {
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        const child: unknown = Reflect.get(value, key);
        bytes += scalarBytes(key) + scalarBytes(child);
        if (child !== null && typeof child === 'object') {
          yield child;
        }
      }
    }
  }
  return bytes;
}

function estimate(value: unknown, deduplicate: boolean): number {
  let bytes = scalarBytes(value);
  if (value === null || typeof value !== 'object') {
    return bytes;
  }
  const seen = deduplicate ? new WeakSet<object>() : undefined;
  seen?.add(value);
  bytes += 64;
  const frames: Generator<object, number>[] = [children(value)];
  while (frames.length > 0) {
    const next = frames[frames.length - 1].next();
    if (next.done) {
      bytes += next.value;
      frames.pop();
      continue;
    }
    if (!seen?.has(next.value)) {
      seen?.add(next.value);
      bytes += 64;
      frames.push(children(next.value));
    }
  }
  return bytes;
}

/**
 * Conservative UTF-16 payload estimate, not a V8 heap measurement. Object identity is counted
 * once per walk; repeated strings, keys and references are charged separately. Iterator frames
 * follow tree depth; weak identity membership scales with visited objects. Neither copies text
 * nor allocates a second entries array, including for large arrays and tool arguments.
 */
export function estimateRetainedJsonBytes(value: unknown): number {
  return estimate(value, true);
}

/**
 * Only for an unmodified JSON.parse tree (without a reviver) or one of its subtrees.
 * Such values cannot contain aliases or cycles, so no object identity set is allocated.
 * Translated requests can share objects and must use estimateRetainedJsonBytes instead.
 */
export function estimateParsedJsonBytes(value: unknown): number {
  return estimate(value, false);
}
