import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type FormattingOptions,
  type JSONPath,
  type ParseError,
  type Node,
  SyntaxKind,
} from 'jsonc-parser';
import { isEqual } from 'lodash-es';
import {
  canonicalizeOpenCodeModelId,
  OPEN_CODE_MODEL_ALIASES,
} from './opencode-model-normalization';

export const OPEN_CODE_PROVIDER_ID = 'antigravity-manager';
export const OPEN_CODE_API_KEY_PLACEHOLDER = '__ANTIGRAVITY_MANAGER_OPENCODE_KEY__';

export interface OpenCodeModelInput {
  id: string;
  name?: string;
}

export interface UpdateOpenCodeConfigInput {
  apiKey: string;
  baseUrl: string;
  models?: OpenCodeModelInput[];
}

export interface ClearOpenCodeConfigInput {
  baseUrl: string;
  clearLegacy: boolean;
}

interface OpenCodeModelDefinition {
  name: string;
  limit?: {
    context: number;
    output: number;
  };
  modalities?: {
    input: string[];
    output: string[];
  };
  reasoning?: boolean;
  variants?: Record<string, unknown>;
}

const PROVIDER_PATH: JSONPath = ['provider', OPEN_CODE_PROVIDER_ID];
const API_KEY_PATH: JSONPath = [...PROVIDER_PATH, 'options', 'apiKey'];

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildThinkingVariant(
  budget: number,
  includeTopLevelBudget = false,
): Record<string, unknown> {
  const variant: Record<string, unknown> = {
    thinkingConfig: {
      thinkingBudget: budget,
    },
    thinking: {
      type: 'enabled',
      budget_tokens: budget,
      budgetTokens: budget,
    },
  };
  if (includeTopLevelBudget) {
    variant.budgetTokens = budget;
  }
  return variant;
}

const CLAUDE_VARIANTS = {
  low: buildThinkingVariant(8192),
  medium: buildThinkingVariant(16384),
  high: buildThinkingVariant(24576),
  max: buildThinkingVariant(32768),
};

const MODEL_CATALOG: Record<string, OpenCodeModelDefinition> = {
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  },
  'claude-sonnet-4-6-thinking': {
    name: 'Claude Sonnet 4.6 Thinking',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    variants: CLAUDE_VARIANTS,
  },
  'claude-opus-4-5-thinking': {
    name: 'Claude Opus 4.5 Thinking',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    variants: CLAUDE_VARIANTS,
  },
  'claude-opus-4-6-thinking': {
    name: 'Claude Opus 4.6 Thinking',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    variants: CLAUDE_VARIANTS,
  },
  'gemini-3.1-pro': {
    name: 'Gemini 3.1 Pro',
    limit: { context: 1048576, output: 65535 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    variants: {
      low: buildThinkingVariant(1001, true),
      high: buildThinkingVariant(10001, true),
    },
  },
  'gemini-3.5-flash': {
    name: 'Gemini 3.5 Flash',
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    variants: {
      low: buildThinkingVariant(1000, true),
      medium: buildThinkingVariant(4000, true),
      high: buildThinkingVariant(10000, true),
    },
  },
  'gemini-3.1-flash-lite': {
    name: 'Gemini 3.1 Flash Lite',
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
  },
  'gemini-3-pro-image': {
    name: 'Gemini 3 Pro Image',
    limit: { context: 1048576, output: 65535 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text', 'image'] },
  },
  'gemini-2.5-flash': {
    name: 'Gemini 2.5 Flash',
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  },
  'gemini-2.5-flash-lite': {
    name: 'Gemini 2.5 Flash Lite',
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  },
  'gemini-2.5-flash-thinking': {
    name: 'Gemini 2.5 Flash Thinking',
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    variants: {
      low: buildThinkingVariant(8192),
      medium: buildThinkingVariant(12288),
      high: buildThinkingVariant(16384),
      max: buildThinkingVariant(24576),
    },
  },
  'gemini-2.5-pro': {
    name: 'Gemini 2.5 Pro',
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
  },
};

const LEGACY_MANAGED_MODEL_IDS = [
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking',
  'claude-opus-4-5-thinking',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3-pro-high',
  'gemini-3-pro-low',
  'gemini-3-flash',
  'gemini-3-pro-image',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
] as const;

function validateJsoncObject(source: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isUnknownRecord(value)) {
    throw new Error('OpenCode configuration is not a valid JSONC object');
  }
  return value;
}

function detectFormatting(source: string): FormattingOptions {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const indentation = source.match(/^(?<indent>[ \t]+)"/m)?.groups?.indent ?? '  ';
  const insertSpaces = !indentation.includes('\t');
  return {
    eol,
    insertSpaces,
    tabSize: insertSpaces ? indentation.length : 2,
  };
}

function getPathValue(root: Record<string, unknown>, path: JSONPath): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isUnknownRecord(current) || typeof segment !== 'string') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setJsoncValue(
  source: string,
  path: JSONPath,
  value: unknown,
  formattingOptions: FormattingOptions,
): string {
  const currentValue = getPathValue(validateJsoncObject(source), path);
  if (currentValue !== undefined && isEqual(currentValue, value)) {
    return source;
  }

  return applyEdits(
    source,
    modify(source, path, value, {
      formattingOptions,
      getInsertionIndex: undefined,
      isArrayInsertion: false,
    }),
  );
}

function setJsoncValueIfMissing(
  source: string,
  path: JSONPath,
  value: unknown,
  formattingOptions: FormattingOptions,
): string {
  const root = validateJsoncObject(source);
  if (getPathValue(root, path) !== undefined) {
    return source;
  }
  return setJsoncValue(source, path, value, formattingOptions);
}

/**
 * Merge managed catalog leaves instead of replacing a whole model object.
 * This keeps comments and user-owned fields inside existing model entries.
 */
function mergeJsoncObject(
  source: string,
  path: JSONPath,
  value: Record<string, unknown>,
  formattingOptions: FormattingOptions,
): string {
  let updated = source;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (isUnknownRecord(child)) {
      updated = mergeJsoncObject(updated, childPath, child, formattingOptions);
      continue;
    }
    updated = setJsoncValue(updated, childPath, child, formattingOptions);
  }
  return updated;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function buildFallbackModel(input: OpenCodeModelInput): OpenCodeModelDefinition {
  const id = canonicalizeOpenCodeModelId(input.id);
  const name =
    input.name?.trim() || id.replaceAll('-', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  const definition: OpenCodeModelDefinition = { name };

  if (id.startsWith('claude')) {
    definition.limit = { context: 200000, output: 64000 };
    definition.modalities = { input: ['text', 'image', 'pdf'], output: ['text'] };
  } else if (id.startsWith('gemini-')) {
    definition.limit = { context: 1048576, output: 65536 };
    definition.modalities = { input: ['text', 'image', 'pdf'], output: ['text'] };
  }
  return definition;
}

function normalizeModelInputs(models: OpenCodeModelInput[]): OpenCodeModelInput[] {
  const normalized = new Map<string, OpenCodeModelInput>();
  for (const model of models) {
    const id = canonicalizeOpenCodeModelId(model.id);
    if (!id) {
      continue;
    }
    const previous = normalized.get(id);
    normalized.set(id, {
      id,
      name: previous?.name ?? model.name,
    });
  }
  return [...normalized.values()];
}

function getJsoncNode(source: string, path: JSONPath): Node | undefined {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!tree || errors.length > 0) {
    throw new Error('OpenCode configuration is not a valid JSONC object');
  }
  return findNodeAtLocation(tree, path);
}

function renameJsoncProperty(source: string, path: JSONPath, nextName: string): string {
  const valueNode = getJsoncNode(source, path);
  const keyNode = valueNode?.parent?.children?.[0];
  if (!keyNode || keyNode.type !== 'string') {
    return source;
  }
  return `${source.slice(0, keyNode.offset)}${JSON.stringify(nextName)}${source.slice(
    keyNode.offset + keyNode.length,
  )}`;
}

function extractJsoncComments(source: string, node: Node | undefined): string[] {
  if (!node) {
    return [];
  }

  const raw = source.slice(node.offset, node.offset + node.length);
  const scanner = createScanner(raw, false);
  const comments: string[] = [];
  let token = scanner.scan();
  while (token !== SyntaxKind.EOF) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      comments.push(
        raw.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()),
      );
    }
    token = scanner.scan();
  }
  return comments;
}

function appendMissingCommentsToObject(
  source: string,
  path: JSONPath,
  comments: string[],
  formattingOptions: FormattingOptions,
): string {
  const missingComments = comments.filter((comment) => !source.includes(comment));
  if (missingComments.length === 0) {
    return source;
  }

  const objectNode = getJsoncNode(source, path);
  if (!objectNode || objectNode.type !== 'object') {
    return source;
  }

  const closingOffset = objectNode.offset + objectNode.length - 1;
  const lineStart = source.lastIndexOf(formattingOptions.eol ?? '\n', closingOffset - 1);
  const insertionOffset =
    lineStart >= 0 ? lineStart + (formattingOptions.eol ?? '\n').length : closingOffset;
  const closingIndent = source.slice(insertionOffset, closingOffset);
  const indentUnit = formattingOptions.insertSpaces
    ? ' '.repeat(formattingOptions.tabSize ?? 2)
    : '\t';
  const commentIndent = `${closingIndent}${indentUnit}`;
  const eol = formattingOptions.eol ?? '\n';
  const formattedComments = missingComments
    .map((comment) =>
      comment
        .trim()
        .split(/\r?\n/)
        .map((line) => `${commentIndent}${line.trimStart()}`)
        .join(eol),
    )
    .join(eol);

  return `${source.slice(0, insertionOffset)}${formattedComments}${eol}${source.slice(
    insertionOffset,
  )}`;
}

function migrateGeminiAliasModels(source: string, formattingOptions: FormattingOptions): string {
  let updated = source;
  for (const [alias, canonical] of Object.entries(OPEN_CODE_MODEL_ALIASES)) {
    const aliasPath = [...PROVIDER_PATH, 'models', alias];
    const canonicalPath = [...PROVIDER_PATH, 'models', canonical];
    const root = validateJsoncObject(updated);
    const aliasValue = getPathValue(root, aliasPath);
    if (aliasValue === undefined) {
      continue;
    }

    const canonicalValue = getPathValue(root, canonicalPath);
    if (canonicalValue === undefined) {
      updated = renameJsoncProperty(updated, aliasPath, canonical);
      continue;
    }

    const aliasNode = getJsoncNode(updated, aliasPath)?.parent;
    const comments = extractJsoncComments(updated, aliasNode);
    if (isUnknownRecord(aliasValue) && isUnknownRecord(canonicalValue)) {
      for (const [key, value] of Object.entries(aliasValue)) {
        if (!Object.prototype.hasOwnProperty.call(canonicalValue, key)) {
          updated = setJsoncValue(updated, [...canonicalPath, key], value, formattingOptions);
        }
      }
    }
    updated = setJsoncValue(updated, aliasPath, undefined, formattingOptions);
    updated = appendMissingCommentsToObject(updated, canonicalPath, comments, formattingOptions);
  }
  return updated;
}

function removeJsoncObjectIfEmpty(
  source: string,
  path: JSONPath,
  formattingOptions: FormattingOptions,
): string {
  const value = getPathValue(validateJsoncObject(source), path);
  return isUnknownRecord(value) && Object.keys(value).length === 0
    ? setJsoncValue(source, path, undefined, formattingOptions)
    : source;
}

export function clearOpenCodeConfigJsonc(source: string, input: ClearOpenCodeConfigInput): string {
  validateJsoncObject(source);
  const formattingOptions = detectFormatting(source);
  let updated = setJsoncValue(source, PROVIDER_PATH, undefined, formattingOptions);

  if (input.clearLegacy) {
    for (const providerId of ['anthropic', 'google']) {
      const providerPath: JSONPath = ['provider', providerId];
      const modelsPath: JSONPath = [...providerPath, 'models'];
      for (const modelId of LEGACY_MANAGED_MODEL_IDS) {
        const modelPath = [...modelsPath, modelId];
        if (getPathValue(validateJsoncObject(updated), modelPath) !== undefined) {
          updated = setJsoncValue(updated, modelPath, undefined, formattingOptions);
        }
      }
      updated = removeJsoncObjectIfEmpty(updated, modelsPath, formattingOptions);

      const optionsPath: JSONPath = [...providerPath, 'options'];
      const options = getPathValue(validateJsoncObject(updated), optionsPath);
      const configuredBaseUrl = isUnknownRecord(options) ? options.baseURL : undefined;
      if (
        typeof configuredBaseUrl === 'string' &&
        normalizeBaseUrl(configuredBaseUrl) === normalizeBaseUrl(input.baseUrl)
      ) {
        updated = setJsoncValue(updated, [...optionsPath, 'baseURL'], undefined, formattingOptions);
        updated = setJsoncValue(updated, [...optionsPath, 'apiKey'], undefined, formattingOptions);
      }
      updated = removeJsoncObjectIfEmpty(updated, optionsPath, formattingOptions);
    }
  }

  return removeJsoncObjectIfEmpty(updated, ['provider'], formattingOptions);
}

export function updateOpenCodeConfigJsonc(
  source: string,
  input: UpdateOpenCodeConfigInput,
): string {
  validateJsoncObject(source);
  const formattingOptions = detectFormatting(source);
  let updated = source;

  updated = setJsoncValueIfMissing(
    updated,
    ['$schema'],
    'https://opencode.ai/config.json',
    formattingOptions,
  );
  updated = setJsoncValueIfMissing(
    updated,
    [...PROVIDER_PATH, 'npm'],
    '@ai-sdk/anthropic',
    formattingOptions,
  );
  updated = setJsoncValueIfMissing(
    updated,
    [...PROVIDER_PATH, 'name'],
    'Antigravity Manager',
    formattingOptions,
  );
  updated = setJsoncValue(
    updated,
    [...PROVIDER_PATH, 'options', 'baseURL'],
    normalizeBaseUrl(input.baseUrl),
    formattingOptions,
  );
  updated = setJsoncValue(updated, API_KEY_PATH, input.apiKey, formattingOptions);
  updated = migrateGeminiAliasModels(updated, formattingOptions);

  const models = normalizeModelInputs(
    input.models ?? Object.keys(MODEL_CATALOG).map((id) => ({ id })),
  );
  for (const model of models) {
    const definition = MODEL_CATALOG[model.id] ?? buildFallbackModel(model);
    updated = mergeJsoncObject(
      updated,
      [...PROVIDER_PATH, 'models', model.id],
      definition as unknown as Record<string, unknown>,
      formattingOptions,
    );
  }

  return updated;
}

export function redactOpenCodeApiKeyForBackup(source: string): string {
  const root = validateJsoncObject(source);
  if (getPathValue(root, API_KEY_PATH) === undefined) {
    return source;
  }
  return setJsoncValue(
    source,
    API_KEY_PATH,
    OPEN_CODE_API_KEY_PLACEHOLDER,
    detectFormatting(source),
  );
}

export function injectOpenCodeApiKeyAfterRestore(source: string, apiKey: string): string {
  validateJsoncObject(source);
  return setJsoncValue(source, API_KEY_PATH, apiKey, detectFormatting(source));
}
