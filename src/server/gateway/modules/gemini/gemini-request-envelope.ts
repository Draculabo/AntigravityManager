import { randomUUID } from 'node:crypto';
import { prepareGoogleGenerationContents } from '../../common/generation-history';
import { isString } from 'lodash-es';
import type { GeminiRequest } from '../../common/interfaces/request-interfaces';
import type { GeminiInternalRequest } from '../../../../modules/proxy-gateway/antigravity/types';
import { normalizeGeminiToolConfigAliases } from '../../../../modules/proxy-gateway/antigravity/GeminiToolConfigCompat';
import { normalizeFunctionCallSignatureAliases } from '../../../../modules/proxy-gateway/antigravity/ThoughtSignatureCompat';
import { requiresToolQuotaRoute } from '../../../../modules/proxy-gateway/antigravity/ToolQuotaRoute';
import {
  formatGlobalSystemPrompt,
  resolveGlobalSystemPrompt,
} from '../../../../modules/proxy-gateway/antigravity/GlobalSystemPrompt';
import { getServerConfig } from '@/server/server-config';
import { normalizeSystemPrompt } from '../../compatibility/client-compatibility';
import { recordPromptTransformation } from '../../common/prompt-transformation-diagnostics';

export function toInternalGeminiRequest(
  request: GeminiRequest,
  includeGlobalSystemPrompt = true,
  configuredGlobalPrompt?: string | null,
): GeminiInternalRequest['request'] {
  const systemInstructionParts = request.systemInstruction?.parts
    .flatMap((part, index) =>
      !isString(part.text)
        ? []
        : [
            {
              ...part,
              text:
                part.thought === true ||
                part.thoughtSignature !== undefined ||
                part.thought_signature !== undefined
                  ? part.text
                  : normalizeSystemPrompt(part.text, (kind) =>
                      recordPromptTransformation({
                        kind,
                        surface: 'system',
                        message: null,
                        part: index,
                      }),
                    ),
            },
          ],
    )
    .filter(
      (part) =>
        part.text !== '' ||
        part.thought === true ||
        part.thoughtSignature !== undefined ||
        part.thought_signature !== undefined,
    );
  const globalSystemPrompt = includeGlobalSystemPrompt
    ? configuredGlobalPrompt === undefined
      ? resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt)
      : configuredGlobalPrompt
    : null;
  if (globalSystemPrompt) {
    recordPromptTransformation({
      kind: 'global-system-prepended',
      surface: 'system',
      message: null,
      part: 0,
    });
  }

  return {
    generationConfig: request.generationConfig,
    safetySettings: request.safetySettings,
    tools: request.tools,
    ...normalizeGeminiToolConfigAliases(request),
    systemInstruction:
      (systemInstructionParts?.length ?? 0) > 0 || globalSystemPrompt
        ? {
            parts: globalSystemPrompt
              ? [
                  { text: formatGlobalSystemPrompt(globalSystemPrompt) },
                  ...(systemInstructionParts ?? []),
                ]
              : (systemInstructionParts ?? []),
          }
        : undefined,
    contents: normalizeFunctionCallSignatureAliases(request.contents),
  };
}

/** Shared envelope for the native Gemini endpoint and the main-process warmup adapter. */
export function createGeminiRequestEnvelope(
  model: string,
  request: GeminiRequest,
  projectId: string | undefined,
  requestType: string,
  userAgent: string,
  requestId = `agent/${Date.now()}/${randomUUID().replaceAll('-', '').slice(0, 8)}`,
  globalSystemPrompt?: string | null,
): GeminiInternalRequest {
  const project = projectId?.trim();
  const isImageRequest = requestType === 'image_gen' || model.toLowerCase().includes('-image');
  const internalRequest = toInternalGeminiRequest(request, !isImageRequest, globalSystemPrompt);
  internalRequest.contents = prepareGoogleGenerationContents(internalRequest.contents, model);
  const providerRequestType =
    requestType === 'image_gen'
      ? 'image_gen'
      : requiresToolQuotaRoute({ tools: internalRequest.tools, contents: internalRequest.contents })
        ? 'agent'
        : undefined;
  return {
    requestId,
    request: internalRequest,
    model,
    userAgent,
    ...(project ? { project } : {}),
    ...(providerRequestType ? { requestType: providerRequestType } : {}),
    ...(providerRequestType === 'agent' ? { enabledCreditTypes: ['GOOGLE_ONE_AI'] } : {}),
  };
}
