import type { GeminiInternalRequest, GeminiPart } from '../../../modules/proxy-gateway/antigravity/types';

/**
 * Local heuristic diagnostics. This is not a provider token count, an
 * admission limit, or a reason to rewrite or trim the caller's history.
 */
export interface RequestContextEstimate {
  algorithmVersion: number;
  estimatedInputTokens: number;
  systemTokens: number;
  textTokens: number;
  toolTokens: number;
  thoughtMetadataTokens: number;
  mediaTokens: number;
  messageOverheadTokens: number;
  signatureCharacters: number;
  inlineMediaBytes: number;
  unestimatedMediaParts: number;
  messages: number;
}

function estimateText(text: string): number {
  if (text === '') {
    return 0;
  }

  let asciiCharacters = 0;
  let unicodeCharacters = 0;
  for (const character of text) {
    if (character.charCodeAt(0) <= 127) {
      asciiCharacters += 1;
    } else {
      unicodeCharacters += 1;
    }
  }

  return Math.max(1, Math.round(asciiCharacters / 4 + unicodeCharacters / 2.2));
}

function estimateInlineMedia(part: NonNullable<GeminiPart['inlineData']>): {
  bytes: number;
  tokens: number;
  unestimated: number;
} {
  const padding = part.data.endsWith('==') ? 2 : part.data.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((part.data.length * 3) / 4) - padding);

  if (part.mimeType.startsWith('image/')) {
    const tokens =
      bytes > 4_000_000
        ? 10_000
        : bytes > 1_000_000
          ? Math.ceil(((258 * bytes) / 1_000_000) * 4)
          : 258;
    return { bytes, tokens, unestimated: 0 };
  }

  // The gateway envelope carries no verified audio duration or sample format.
  return { bytes, tokens: 0, unestimated: 1 };
}

/**
 * Estimates the semantic input after thought replay and before an explicit
 * context cache moves the static prefix out of the request. Routing IDs and
 * output reservations are deliberately excluded.
 */
export function estimateRequestContext(body: GeminiInternalRequest): RequestContextEstimate {
  const request = body.request;
  const estimate: RequestContextEstimate = {
    algorithmVersion: 2,
    estimatedInputTokens: 0,
    systemTokens: 0,
    textTokens: 0,
    toolTokens: 0,
    thoughtMetadataTokens: 0,
    mediaTokens: 0,
    messageOverheadTokens: request.contents.length * 4,
    signatureCharacters: 0,
    inlineMediaBytes: 0,
    unestimatedMediaParts: 0,
    messages: request.contents.length,
  };

  for (const part of request.systemInstruction?.parts ?? []) {
    estimate.systemTokens += estimateText(part.text);
  }
  for (const tool of request.tools ?? []) {
    estimate.toolTokens += estimateText(JSON.stringify(tool));
  }

  const toolConfig = request.toolConfig ?? request.tool_config;
  if (toolConfig) {
    estimate.toolTokens += estimateText(JSON.stringify(toolConfig));
  }

  for (const content of request.contents) {
    for (const part of content.parts) {
      estimate.textTokens += estimateText(part.text ?? '');

      const signature = part.thoughtSignature ?? part.thought_signature;
      estimate.signatureCharacters += signature?.length ?? 0;
      if (part.thought || signature) {
        estimate.thoughtMetadataTokens += 100;
      }

      if (part.functionCall) {
        estimate.toolTokens +=
          20 +
          estimateText(part.functionCall.name) +
          estimateText(JSON.stringify(part.functionCall.args));
      }
      if (part.functionResponse) {
        estimate.toolTokens +=
          10 +
          estimateText(part.functionResponse.name) +
          estimateText(JSON.stringify(part.functionResponse.response));
      }

      if (part.inlineData) {
        const media = estimateInlineMedia(part.inlineData);
        estimate.mediaTokens += media.tokens;
        estimate.inlineMediaBytes += media.bytes;
        estimate.unestimatedMediaParts += media.unestimated;
      }
      if (part.fileData) {
        estimate.unestimatedMediaParts += 1;
      }
    }
  }

  estimate.estimatedInputTokens =
    estimate.systemTokens +
    estimate.textTokens +
    estimate.toolTokens +
    estimate.thoughtMetadataTokens +
    estimate.mediaTokens +
    estimate.messageOverheadTokens;

  return estimate;
}
