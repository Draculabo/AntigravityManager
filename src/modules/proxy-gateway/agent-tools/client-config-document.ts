import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { isMap, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';

export const ClientConfigValueSchema = z.json();
export type ClientConfigValue = z.infer<typeof ClientConfigValueSchema>;
export interface ClientConfigDocument {
  get(path: string[]): ClientConfigValue | undefined;
  set(path: string[], value: ClientConfigValue | undefined): void;
  render(): string;
}

export function clientConfigDocument(client: 'hermes' | 'openclaw', original: string | null): ClientConfigDocument {
  const source = original ?? '{}\n';
  if (client === 'hermes') {
    let changed = false;
    const document = parseDocument(source, { stringKeys: true, keepSourceTokens: true });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
      throw new Error('Invalid Hermes configuration');
    }
    // Alias writes can silently change unrelated personal settings through shared YAML nodes.
    const value = ClientConfigValueSchema.parse(document.toJS({ maxAliasCount: 0 }));
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('Invalid Hermes root');
    }
    return {
      get: (path) => {
        let found: ClientConfigValue | undefined = ClientConfigValueSchema.parse(document.toJS({ maxAliasCount: 0 }));
        for (const segment of path) {
          if (found === null || Array.isArray(found) || typeof found !== 'object') {
            return undefined;
          }
          found = Object.hasOwn(found, segment) ? found[segment] : undefined;
        }
        return found;
      },
      set: (path, value) => {
        changed = true;
        for (let index = 1; index < path.length; index += 1) {
          const parent = document.getIn(path.slice(0, index), true);
          if (parent !== undefined && !isMap(parent)) {
            throw new Error('Invalid Hermes mapping');
          }
        }
        if (value === undefined) {
          document.deleteIn(path);
        } else {
          const node = document.getIn(path, true);
          if (isScalar(node) && (typeof value !== 'object' || value === null)) {
            node.value = value;
          } else {
            document.setIn(path, value);
          }
        }
      },
      render: () => {
        if (!changed) {
          return source;
        }
        const rendered = document.toString();
        return source.includes('\r\n') ? rendered.replace(/\r?\n/g, '\r\n') : rendered;
      },
    };
  }
  let updated = source;
  function root() {
    const errors: ParseError[] = [];
    const raw: unknown = parse(updated, errors, { allowTrailingComma: true, disallowComments: false });
    const value = ClientConfigValueSchema.parse(raw);
    if (errors.length || value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('Invalid OpenClaw configuration');
    }
    return value;
  }
  function get(path: string[]): ClientConfigValue | undefined {
    let value: ClientConfigValue | undefined = root();
    for (const segment of path) {
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        return undefined;
      }
      value = Object.hasOwn(value, segment) ? value[segment] : undefined;
    }
    return value;
  }
  root();
  return {
    get,
    set: (path, value) => {
      for (let index = 1; index < path.length; index += 1) {
        const parent = get(path.slice(0, index));
        if (parent !== undefined && (parent === null || Array.isArray(parent) || typeof parent !== 'object')) {
          throw new Error('Invalid OpenClaw mapping');
        }
      }
      updated = applyEdits(updated, modify(updated, path, value, {
        formattingOptions: {
          insertSpaces: !/^\t/m.test(source), tabSize: source.match(/^ +(?=")/m)?.[0].length ?? 2,
          eol: source.includes('\r\n') ? '\r\n' : '\n',
        },
      }));
      root();
    },
    render: () => updated,
  };
}
