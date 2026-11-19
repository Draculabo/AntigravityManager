import { createHash } from 'node:crypto';
import { sortBy } from 'lodash-es';
import { logger } from '@/shared/logging/logger';
import { normalizeObjectJsonSchema } from './JsonSchemaUtils';
import { SchemaConversionBatch, validateSchemaInput } from './schema/SchemaConversion';
import { reportSchemaIssues } from './schema/SchemaPreparation';
import { isGoogleSearchToolType } from './ToolChoiceCompat';
import type { FunctionDeclaration, GeminiToolDeclaration, Tool } from './types';

const TOOL_SCHEMA_CACHE_LIMIT = 100;

const TOOL_SCHEMA_CACHE_TTL_MS = 30 * 60 * 1000;

interface ToolSchemaCacheEntry {
  declarations: FunctionDeclaration[];
  hitCount: number;
  timestamp: number;
}

const toolSchemaCache = new Map<string, ToolSchemaCacheEntry>();

/**
 * Detects if networking tools are present
 * Checks tool list for web search related tools
 * Supports Claude Tool and Gemini GeminiToolDeclaration formats
 */
export function detectsNetworkingTool(tools?: (Tool | GeminiToolDeclaration)[]): boolean {
  if (!tools) {
    return false;
  }

  for (const tool of tools) {
    const toolType = (tool as { type?: unknown }).type;
    if (isGoogleSearchToolType(toolType)) {
      return true;
    }
    if ('googleSearch' in tool && tool.googleSearch) {
      return true;
    }
    if ('googleSearchRetrieval' in tool && tool.googleSearchRetrieval) {
      return true;
    }
  }
  return false;
}

export function injectGoogleSearchTool(
  body: { tools?: GeminiToolDeclaration[] },
  mappedModel?: string,
) {
  if (!body.tools) {
    body.tools = [];
  }
  const toolsArr = body.tools;

  const hasFunctions = toolsArr.some((t) => t.functionDeclarations);
  if (hasFunctions) {
    logger.info(
      `[Claude-Request] Skipping googleSearch injection for ${mappedModel ?? 'unknown-model'} because functionDeclarations are present (v1internal incompatible)`,
    );
    return;
  }

  // Remove existing to avoid duplicates
  body.tools = toolsArr.filter((t) => !t.googleSearch && !t.googleSearchRetrieval);
  body.tools.push({ googleSearch: {} });
}

/**
 * build tools
 * convert claude tools to gemini function declarations
 */
export function buildTools(
  tools: Tool[] | undefined,
  hasWebSearch: boolean,
  mappedModel: string,
  options: { schemasPrepared?: boolean; cacheSchemas?: boolean },
): GeminiToolDeclaration[] | null {
  if (!tools || tools.length === 0) {
    return null;
  }

  const batch = new SchemaConversionBatch();
  if (!options.schemasPrepared) {
    for (const tool of tools) {
      if (!isGoogleSearchTool(tool)) {
        validateSchemaInput(tool.input_schema ?? { type: 'object', properties: {} }, batch);
      }
    }
  }
  const hasGoogleSearch = hasWebSearch || tools.some(isGoogleSearchTool);
  const cacheKey = options.cacheSchemas === false ? null : computeToolSchemaCacheKey(tools);
  let functionDeclarations = cacheKey ? lookupToolSchemaCache(cacheKey) : null;
  if (functionDeclarations && !options.schemasPrepared) {
    for (const declaration of functionDeclarations) {
      validateSchemaInput(declaration.parameters, batch);
    }
  }

  if (!functionDeclarations) {
    functionDeclarations = [];
    for (const tool of tools) {
      if (isGoogleSearchTool(tool)) {
        continue;
      }
      if (tool.name) {
        const inputSchema = options.schemasPrepared
          ? structuredClone(tool.input_schema ?? { type: 'object', properties: {} })
          : normalizeObjectJsonSchema(
              tool.input_schema,
              batch,
              'tool',
              functionDeclarations.length,
            );
        functionDeclarations.push({
          name: tool.name,
          description: tool.description,
          parameters: inputSchema,
        });
      }
    }

    if (cacheKey && !batch.degraded) {
      cacheToolSchemas(cacheKey, functionDeclarations);
    }
  }

  functionDeclarations = sortBy(functionDeclarations, (declaration) => declaration.name);
  reportSchemaIssues(batch, 'anthropic');

  const toolList: GeminiToolDeclaration[] = [];
  if (functionDeclarations.length > 0) {
    toolList.push({ functionDeclarations });
    if (hasGoogleSearch) {
      logger.info(
        `[Claude-Request] Skipping googleSearch injection for ${mappedModel} because functionDeclarations are present (v1internal incompatible)`,
      );
    }
  } else if (hasGoogleSearch) {
    toolList.push({ googleSearch: {} });
  }

  if (toolList.length > 0) {
    return toolList;
  }
  return null;
}

function isGoogleSearchTool(tool: Tool): boolean {
  return isGoogleSearchToolType(tool.type);
}

function computeToolSchemaCacheKey(tools: Tool[]): string | null {
  try {
    const rawJson = JSON.stringify(tools);
    if (!rawJson) {
      return null;
    }
    return createHash('sha256').update(rawJson).digest('hex');
  } catch {
    return null;
  }
}

function lookupToolSchemaCache(key: string): FunctionDeclaration[] | null {
  const entry = toolSchemaCache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > TOOL_SCHEMA_CACHE_TTL_MS) {
    toolSchemaCache.delete(key);
    return null;
  }

  try {
    entry.hitCount += 1;
    logger.debug(
      `[ToolSchemaCache] HIT hash=${key.slice(0, 16)} hitCount=${entry.hitCount} declarations=${entry.declarations.length}`,
    );
    return structuredClone(entry.declarations);
  } catch {
    toolSchemaCache.delete(key);
    return null;
  }
}

function cacheToolSchemas(key: string, declarations: FunctionDeclaration[]): void {
  try {
    toolSchemaCache.set(key, {
      declarations: structuredClone(declarations),
      hitCount: 0,
      timestamp: Date.now(),
    });
  } catch {
    return;
  }

  evictToolSchemaCache();
  logger.debug(
    `[ToolSchemaCache] INSERT hash=${key.slice(0, 16)} declarations=${declarations.length}`,
  );
}

function evictToolSchemaCache(): void {
  const oldestAllowed = Date.now() - TOOL_SCHEMA_CACHE_TTL_MS;
  for (const [key, entry] of toolSchemaCache) {
    if (entry.timestamp < oldestAllowed) {
      toolSchemaCache.delete(key);
    }
  }

  while (toolSchemaCache.size > TOOL_SCHEMA_CACHE_LIMIT) {
    const oldestKey = toolSchemaCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    toolSchemaCache.delete(oldestKey);
  }
}
