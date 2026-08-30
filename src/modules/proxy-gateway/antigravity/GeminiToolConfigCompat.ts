import { isEqual } from 'lodash-es';
import { z } from 'zod';
import type { GeminiRequest, GeminiToolConfig, GeminiSnakeToolConfig } from './types';

const FunctionConfigSchema = z
  .object({
    mode: z.string().optional(),
    allowedFunctionNames: z.array(z.string()).optional(),
  })
  .catchall(z.json());
const SnakeFunctionConfigSchema = z
  .object({
    mode: z.string().optional(),
    allowed_function_names: z.array(z.string()).optional(),
  })
  .catchall(z.json());

/** Validate external aliases while retaining provider extensions for passthrough. */
export const GeminiToolConfigAliasesSchema = z.object({
  toolConfig: z
    .object({
      functionCallingConfig: FunctionConfigSchema.optional(),
      includeServerSideToolInvocations: z.boolean().optional(),
    })
    .catchall(z.json())
    .optional(),
  tool_config: z
    .object({
      function_calling_config: SnakeFunctionConfigSchema.optional(),
      include_server_side_tool_invocations: z.boolean().optional(),
    })
    .catchall(z.json())
    .optional(),
});

export function toSnakeToolConfig(config: GeminiToolConfig): GeminiSnakeToolConfig {
  return {
    ...(config.functionCallingConfig === undefined
      ? {}
      : {
          function_calling_config: {
            ...(config.functionCallingConfig.mode === undefined
              ? {}
              : { mode: config.functionCallingConfig.mode }),
            ...(config.functionCallingConfig.allowedFunctionNames === undefined
              ? {}
              : {
                  allowed_function_names: config.functionCallingConfig.allowedFunctionNames,
                }),
          },
        }),
    ...(config.includeServerSideToolInvocations === undefined
      ? {}
      : {
          include_server_side_tool_invocations: config.includeServerSideToolInvocations,
        }),
  };
}

/** Each alias has its own default; an existing empty object is not a missing config. */
export function normalizeGeminiToolConfigAliases(
  request: Pick<GeminiRequest, 'tools' | 'toolConfig' | 'tool_config'>,
): Pick<GeminiRequest, 'toolConfig' | 'tool_config'> {
  if (request.tools === undefined) {
    return { toolConfig: request.toolConfig, tool_config: request.tool_config };
  }
  return {
    toolConfig: {
      ...(request.toolConfig ?? { functionCallingConfig: { mode: 'VALIDATED' } }),
      includeServerSideToolInvocations: true,
    },
    tool_config: {
      ...(request.tool_config ?? { function_calling_config: { mode: 'VALIDATED' } }),
      include_server_side_tool_invocations: true,
    },
  };
}

/** The separate cachedContents API only owns the canonical, known camel-case fields. */
export function canCacheGeminiToolConfig(
  request: Pick<GeminiRequest, 'toolConfig' | 'tool_config'>,
): boolean {
  const { toolConfig, tool_config: snake } = request;
  if (!toolConfig) {
    return snake === undefined;
  }
  const canonical = z
    .object({
      functionCallingConfig: FunctionConfigSchema.strict().optional(),
      includeServerSideToolInvocations: z.boolean().optional(),
    })
    .strict()
    .safeParse(toolConfig);
  if (!canonical.success) {
    return false;
  }
  return snake === undefined || isEqual(snake, toSnakeToolConfig(canonical.data));
}
