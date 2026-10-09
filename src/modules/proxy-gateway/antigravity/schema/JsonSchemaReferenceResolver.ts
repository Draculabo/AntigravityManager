import {
  isSchemaMap,
  SchemaConversionBatch,
  SchemaInputError,
  type JsonSchemaMap,
  type JsonValue,
} from './SchemaConversion';

export const STRING_SCHEMA_FALLBACK: Readonly<JsonSchemaMap> = {
  type: 'string',
  description: 'Schema conversion fallback. Provide this parameter as a string.',
};
const MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const NODE_KEYWORDS = new Set([
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);
const ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function resolvePointer(document: JsonSchemaMap, reference: string): JsonValue {
  if (!reference.startsWith('#')) {
    throw new SchemaInputError('unsupported-reference');
  }
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    throw new SchemaInputError('invalid-reference');
  }
  if (pointer !== '' && !pointer.startsWith('/')) {
    throw new SchemaInputError('unsupported-reference');
  }
  let target: JsonValue = document;
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    if (target !== document && isSchemaMap(target) && target.$id !== undefined) {
      throw new SchemaInputError('unsupported-reference');
    }
    if (/~(?:[^01]|$)/.test(part)) {
      throw new SchemaInputError('invalid-reference');
    }
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(target)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(target, key)) {
        throw new SchemaInputError('invalid-reference');
      }
      target = target[Number(key)];
    } else if (isSchemaMap(target) && Object.hasOwn(target, key)) {
      target = target[key];
    } else {
      throw new SchemaInputError('invalid-reference');
    }
  }
  return target;
}

/** Resolve against the original document, retaining sibling precedence used by the gateway. */
export function resolveSchemaReferences(
  document: JsonSchemaMap,
  batch: SchemaConversionBatch,
  policy: 'tool' | 'output' | 'compatibility',
  toolOrdinal: number | null,
): JsonSchemaMap {
  const active = new Set<JsonSchemaMap>();
  const walk = (
    node: JsonSchemaMap,
    depth: number,
    root: boolean,
    budget: { nodes: number; bytes: number },
    allowRecovery = !root,
  ): JsonSchemaMap => {
    try {
      if (depth > batch.limits.depth || ++budget.nodes > batch.limits.schemaNodes) {
        throw new SchemaInputError('expansion-budget');
      }
      batch.charge(1, 0);
      if (active.has(node)) {
        throw new SchemaInputError('reference-cycle');
      }
      if (
        node.$dynamicRef !== undefined ||
        node.$recursiveRef !== undefined ||
        (!root && node.$id !== undefined)
      ) {
        throw new SchemaInputError('unsupported-reference');
      }
      active.add(node);
      try {
        let source = node;
        if (node.$ref !== undefined) {
          if (typeof node.$ref !== 'string') {
            throw new SchemaInputError('invalid-reference');
          }
          const target = resolvePointer(document, node.$ref);
          if (!isSchemaMap(target)) {
            throw new SchemaInputError('invalid-reference');
          }
          if (target !== document && target.$id !== undefined) {
            throw new SchemaInputError('unsupported-reference');
          }
          // Resolve the target while it is on the stack; sibling declarations win.
          source = { ...walk(target, depth + 1, root, budget, false), ...node };
        }
        const result: JsonSchemaMap = {};
        for (const [key, value] of Object.entries(source)) {
          if (['$ref', '$defs', 'definitions', '$id', '$anchor', '$schema'].includes(key)) {
            continue;
          }
          Object.defineProperty(result, key, {
            value: undefined,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          let literalBytes = 0;
          if (MAP_KEYWORDS.has(key) && isSchemaMap(value)) {
            const children: JsonSchemaMap = {};
            for (const [name, child] of Object.entries(value)) {
              const nameBytes = Buffer.byteLength(JSON.stringify(name)) + 2;
              budget.bytes += nameBytes;
              batch.charge(0, nameBytes);
              if (budget.bytes > batch.limits.schemaBytes) {
                throw new SchemaInputError('expansion-budget');
              }
              Object.defineProperty(children, name, {
                value: isSchemaMap(child)
                  ? walk(child, depth + 1, false, root ? { nodes: 0, bytes: 0 } : budget)
                  : child,
                enumerable: true,
                writable: true,
                configurable: true,
              });
            }
            result[key] = children;
          } else if (NODE_KEYWORDS.has(key) && isSchemaMap(value)) {
            result[key] = walk(value, depth + 1, false, budget);
          } else if (ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
            result[key] = value.map((child) =>
              isSchemaMap(child) ? walk(child, depth + 1, false, budget) : child,
            );
          } else {
            literalBytes = Buffer.byteLength(JSON.stringify(value));
            const pending = [value];
            let copiedNodes = 0;
            while (pending.length > 0) {
              const literal = pending.pop()!;
              copiedNodes++;
              if (Array.isArray(literal)) {
                pending.push(...literal);
              } else if (isSchemaMap(literal)) {
                pending.push(...Object.values(literal));
              }
            }
            batch.charge(copiedNodes, 0);
            result[key] = structuredClone(value);
          }
          const bytes = Buffer.byteLength(JSON.stringify(key)) + 1 + literalBytes;
          budget.bytes += bytes;
          batch.charge(0, bytes);
          if (budget.bytes > batch.limits.schemaBytes) {
            throw new SchemaInputError('expansion-budget');
          }
        }
        return result;
      } finally {
        active.delete(node);
      }
    } catch (error) {
      if (!(error instanceof SchemaInputError)) {
        throw error;
      }
      const recoverable = allowRecovery && policy !== 'output' && error.kind !== 'request-budget';
      if (recoverable) {
        batch.issue(error.kind, true, toolOrdinal);
        return { ...STRING_SCHEMA_FALLBACK };
      }
      throw error;
    }
  };
  return walk(document, 0, true, { nodes: 0, bytes: 0 });
}

export function recordTerminalSchemaIssue(
  batch: SchemaConversionBatch,
  error: unknown,
  toolOrdinal: number | null,
): void {
  if (error instanceof SchemaInputError) {
    batch.issue(error.kind, false, toolOrdinal);
  }
}
