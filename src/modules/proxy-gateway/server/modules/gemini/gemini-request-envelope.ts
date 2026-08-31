import { randomUUID } from 'node:crypto';
import { isString } from 'lodash-es';
import type { GeminiRequest } from '../../common/interfaces/request-interfaces';
import type { GeminiInternalRequest } from '../../../antigravity/types';
import { normalizeGeminiToolConfigAliases } from '../../../antigravity/GeminiToolConfigCompat';
import { injectPlaceholderSignaturesForModel } from '../../../antigravity/ThoughtSignatureCompat';

export function toInternalGeminiRequest(
  request: GeminiRequest,
  model: string,
): GeminiInternalRequest['request'] {
  return {
    contents: injectPlaceholderSignaturesForModel(request.contents, model),
    generationConfig: request.generationConfig,
    tools: request.tools,
    ...normalizeGeminiToolConfigAliases(request),
    systemInstruction: request.systemInstruction
      ? {
          parts: request.systemInstruction.parts
            .filter((part): part is { text: string } => isString(part.text))
            .map((part) => ({ text: part.text })),
        }
      : undefined,
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
): GeminiInternalRequest {
  const project = projectId?.trim();
  return {
    requestId,
    request: toInternalGeminiRequest(request, model),
    model,
    userAgent,
    requestType,
    ...(project ? { project } : {}),
    ...(requestType !== 'image_gen' ? { enabledCreditTypes: ['GOOGLE_ONE_AI'] } : {}),
  };
}
