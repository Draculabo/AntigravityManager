import { createHash } from 'node:crypto';

type Frame =
  | { kind: 'value'; value: unknown }
  | { kind: 'array'; value: readonly unknown[]; index: number }
  | { kind: 'object'; value: object; keys: string[]; index: number };

/** Framed, key-order-stable hashing without serializing full message/media strings. */
export function hashSessionAnchor(value: unknown): string {
  const hash = createHash('sha256');
  const frames: Frame[] = [{ kind: 'value', value }];
  const ancestors = new WeakSet<object>();
  while (frames.length) {
    const frame = frames.pop();
    if (!frame) {
      break;
    }
    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) {
        ancestors.delete(frame.value);
        hash.update(']');
        continue;
      }
      frames.push({ ...frame, index: frame.index + 1 });
      frames.push({ kind: 'value', value: frame.value[frame.index] });
      continue;
    }
    if (frame.kind === 'object') {
      if (frame.index >= frame.keys.length) {
        ancestors.delete(frame.value);
        hash.update('}');
        continue;
      }
      const key = frame.keys[frame.index];
      frames.push({ ...frame, index: frame.index + 1 });
      frames.push({ kind: 'value', value: Reflect.get(frame.value, key) });
      frames.push({ kind: 'value', value: key });
      continue;
    }
    const current = frame.value;
    if (current === null) {
      hash.update('null;');
      continue;
    }
    switch (typeof current) {
      case 'undefined':
        hash.update('undefined;');
        break;
      case 'boolean':
        hash.update(current ? 'true;' : 'false;');
        break;
      case 'number':
        if (!Number.isFinite(current)) {
          throw new Error('Session anchor contains a non-finite number');
        }
        hash.update(`n${current};`);
        break;
      case 'string':
        // UTF-16LE preserves every code unit, including unpaired message-content
        // surrogates, without boundary replacement or allocating a full UTF-8 copy.
        hash.update(`s${current.length}:`);
        for (let offset = 0; offset < current.length; offset += 32768) {
          hash.update(current.slice(offset, offset + 32768), 'utf16le');
        }
        hash.update(';');
        break;
      case 'object':
        if (ancestors.has(current)) {
          throw new Error('Session anchor contains a cycle');
        }
        ancestors.add(current);
        if (Array.isArray(current)) {
          const items: readonly unknown[] = current;
          hash.update(`a${items.length}[`);
          frames.push({ kind: 'array', value: items, index: 0 });
        } else {
          const prototype: unknown = Object.getPrototypeOf(current);
          if (prototype !== null && prototype !== Object.prototype) {
            throw new Error('Session anchor contains a non-JSON object');
          }
          const keys = Object.keys(current)
            .filter((key) => Reflect.get(current, key) !== undefined)
            .sort();
          hash.update(`o${keys.length}{`);
          frames.push({ kind: 'object', value: current, keys, index: 0 });
        }
        break;
      default:
        throw new Error('Session anchor contains a non-JSON value');
    }
  }
  return hash.digest('hex');
}
