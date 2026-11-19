import { isEmpty, isString } from 'lodash-es';
import { getServerConfig } from '@/server/server-config';
import { logger } from '@/shared/logging/logger';
import { recordPromptTransformation } from '../../../server/gateway/common/prompt-transformation-diagnostics';
import { recordThoughtRestoreOutcome } from '../thought-store/thought-restore-diagnostics';
import { ClaudeToolResultAssociation } from './ClaudeToolResultAssociation';
import { resolveGlobalSystemPrompt } from './GlobalSystemPrompt';
import { extractToolResultImages, parseMarkdownImagesToGeminiParts } from './MarkdownImageParts';
import { SignatureStore } from './SignatureStore';
import { hasExplicitAssistantSignature } from './signed-assistant-history';
import { enhanceGeminiSkillsPrompt } from './SkillPromptEnhancer';
import { normalizeSystemPrompt } from '@/server/gateway/compatibility/client-compatibility';
import { modelKeepsThinkingWithoutSignature } from './ThoughtSignatureCompat';
import type { ContentBlock, GeminiContent, GeminiPart, Message, SystemPrompt, Tool } from './types';

export function extractEmbeddedSystemMessages(messages: Message[]): {
  extraSystemMessages: string[];
  messages: Message[];
} {
  const extraSystemMessages: string[] = [];
  const filteredMessages: Message[] = [];
  let initialSystemSection = true;

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'system' && message.role !== 'developer') {
      initialSystemSection = false;
      filteredMessages.push(message);
      continue;
    }

    if (initialSystemSection) {
      const systemBlocks: ContentBlock[] = isString(message.content)
        ? [{ type: 'text', text: message.content }]
        : message.content;
      for (const block of systemBlocks) {
        if (block.type === 'text' && block.text !== '') {
          extraSystemMessages.push(block.text);
        }
      }
      recordPromptTransformation({
        kind: 'initial-system-promoted',
        surface: 'messages',
        message: messageIndex,
        part: null,
      });
      continue;
    }
    const text = isString(message.content)
      ? message.content
      : message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
    if (text !== '') {
      recordPromptTransformation({
        kind: 'late-system-reminder',
        surface: 'messages',
        message: messageIndex,
        part: null,
      });
      filteredMessages.push({
        role: 'user',
        content: `<system-reminder>\n${text}\n</system-reminder>`,
      });
    }
  }

  return { extraSystemMessages, messages: filteredMessages };
}

/**
 * Builds system instruction
 * Preserves initial system block order while applying only system-owned normalization.
 */

export function buildSystemInstruction(
  system: SystemPrompt | undefined,
  extraSystemMessages: string[],
  tools?: Tool[],
  globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt),
): { parts: { text: string }[] } | null {
  const instructions: string[] = [];
  let part = 0;
  const normalize = (text: string) => {
    const index = part++;
    return normalizeSystemPrompt(text, (kind) =>
      recordPromptTransformation({ kind, surface: 'system', message: null, part: index }),
    );
  };

  if (system) {
    if (isString(system)) {
      const cleaned = normalize(system);
      if (cleaned !== '') {
        instructions.push(cleaned);
      }
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text') {
          const cleaned = normalize(block.text);
          if (cleaned !== '') {
            instructions.push(cleaned);
          }
        }
      }
    }
  }

  for (const extraText of extraSystemMessages) {
    if (extraText !== '') {
      const cleaned = normalize(extraText);
      if (cleaned !== '') {
        instructions.push(cleaned);
      }
    }
  }

  if (globalSystemPrompt) {
    recordPromptTransformation({
      kind: 'global-system-prepended',
      surface: 'system',
      message: null,
      part: 0,
    });
  }
  const orderedInstructions = [
    ...(globalSystemPrompt
      ? [`<global_system_prompt>\n${globalSystemPrompt}\n</global_system_prompt>`]
      : []),
    ...instructions,
  ];
  if (orderedInstructions.length === 0) {
    return null;
  }

  const text = orderedInstructions.join('\n');
  return { parts: [{ text: enhanceGeminiSkillsPrompt(text, tools) }] };
}

/**
 * Minimum length for a valid thought_signature
 */
const MIN_SIGNATURE_LENGTH = 10;

/**
 * Check if we have any valid signature available for function calls
 * @param messages Generation history
 * @param sessionSignature  Signature from session-scoped storage
 * @returns  True if any valid signature is available for function calls
 */
export function hasValidSignatureForFunctionCalls(
  messages: Message[],
  sessionSignature: string | null | undefined,
): boolean {
  // 1. Check session-scoped store
  if (sessionSignature && sessionSignature.length >= MIN_SIGNATURE_LENGTH) {
    return true;
  }

  // 2. Check if any message has a thinking block with valid signature
  // Traverse in reverse to find recent signatures
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block.type === 'thinking' &&
            block.signature &&
            block.signature.length >= MIN_SIGNATURE_LENGTH
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Builds message contents
 * Converts Claude message list to Gemini content format
 */
export function buildContents(
  messages: Message[],
  isThinkingEnabled: boolean,
  mappedModel: string,
  signatureSessionKey?: string,
  signatureTargetFamily?: string | null,
  signatureTargetFamilyModel?: string | null,
  protectedMediaContents?: Set<number>,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const currentUserIndex = protectedMediaContents
    ? messages.findLastIndex(
        (message) =>
          message.role === 'user' &&
          !(
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_result')
          ),
      )
    : -1;
  const toolAssociation = new ClaudeToolResultAssociation();
  let missingSignature: { model: string; toolCallId: string } | null = null;

  for (let i = 0; i < messages.length; i++) {
    // A reasoning block can supply calls in its own message, never a later turn.
    let lastThoughtSignature: string | null = null;
    const msg = messages[i];
    const role = msg.role === 'assistant' ? 'model' : msg.role;
    const parts: GeminiPart[] = [];
    const deferredToolResponses: GeminiPart[] = [];
    const deferredToolMedia: GeminiPart[] = [];
    const contentBlocks = Array.isArray(msg.content)
      ? msg.content
      : msg.content
        ? [{ type: 'text' as const, text: msg.content }]
        : [];
    const preserveAssistantText = hasExplicitAssistantSignature(msg.role, contentBlocks);

    for (const [blockIndex, block] of contentBlocks.entries()) {
      const position = `messages[${i}].content[${blockIndex}]`;
      if (block.type === 'text') {
        if (preserveAssistantText) {
          // Signed history is replayed as supplied, including whitespace and literal Markdown.
          parts.push({ text: block.text });
        } else if (block.text && !isEmpty(block.text.trim())) {
          parts.push(...parseMarkdownImagesToGeminiParts(block.text));
        }
      } else if (block.type === 'thinking') {
        const part: GeminiPart = { text: block.thinking, thought: true };
        if (block.signature) {
          lastThoughtSignature = block.signature;
          part.thoughtSignature = block.signature;
          part.thought_signature = block.signature;
        }
        parts.push(part);
      } else if (
        block.type === 'image' ||
        block.type === 'document' ||
        block.type === 'audio' ||
        block.type === 'video'
      ) {
        // Media blocks differ only in what the client called them; the provider
        // takes inline bytes in one part carrying its own MIME type.
        if (block.source.type === 'base64') {
          parts.push({
            inlineData: { mimeType: block.source.media_type, data: block.source.data },
          });
        } else if (
          (block.type === 'audio' || block.type === 'video') &&
          block.source.type === 'url'
        ) {
          parts.push({
            fileData: { mimeType: block.source.media_type, fileUri: block.source.url },
          });
        }
      } else if (block.type === 'tool_use') {
        const part: GeminiPart = {
          functionCall: { name: block.name, args: block.input, id: block.id },
        };
        toolAssociation.add(block, msg.role, position);
        const signatureTarget = {
          model: mappedModel,
          family: signatureTargetFamily,
          familyModel: signatureTargetFamilyModel,
        };
        const cachedSignature = block.signature
          ? null
          : SignatureStore.getForToolCall({
              ...signatureTarget,
              toolCallId: block.id,
              toolName: block.name,
              sessionKey: signatureSessionKey,
            });
        if (!block.signature) {
          recordThoughtRestoreOutcome(
            cachedSignature ? 'signatureCacheHits' : 'signatureCacheMisses',
          );
        }
        const finalSig = block.signature || cachedSignature || lastThoughtSignature;
        if (finalSig) {
          part.thoughtSignature = finalSig;
          part.thought_signature = finalSig;
        } else if (
          !mappedModel.startsWith('projects/') &&
          (isThinkingEnabled || modelKeepsThinkingWithoutSignature(mappedModel))
        ) {
          missingSignature ??= { model: mappedModel, toolCallId: block.id };
        }
        parts.push(part);
      } else if (block.type === 'tool_result') {
        const funcName = toolAssociation.consume(block, msg.role, position);
        let mergedContent = '';
        const extraParts: GeminiPart[] = [];
        if (isString(block.content)) {
          const extracted = extractToolResultImages(block.content);
          mergedContent = extracted.text;
          extraParts.push(...extracted.media);
        } else if (Array.isArray(block.content)) {
          const textParts: string[] = [];
          for (const content of block.content) {
            if (content.type === 'text') {
              const extracted = extractToolResultImages(content.text);
              textParts.push(extracted.text);
              extraParts.push(...extracted.media);
            } else if (
              (content.type === 'image' ||
                content.type === 'document' ||
                content.type === 'audio' ||
                content.type === 'video') &&
              content.source.type === 'base64'
            ) {
              extraParts.push({
                inlineData: {
                  mimeType: content.source.media_type,
                  data: content.source.data,
                },
              });
            } else if (
              (content.type === 'audio' || content.type === 'video') &&
              content.source.type === 'url'
            ) {
              extraParts.push({
                fileData: {
                  mimeType: content.source.media_type,
                  fileUri: content.source.url,
                },
              });
            }
          }
          mergedContent = textParts.join('\n');
        }
        if (isEmpty(mergedContent.trim()) && extraParts.length === 0) {
          mergedContent = block.is_error
            ? 'Tool execution failed with no output.'
            : 'Command executed successfully.';
        }
        const part: GeminiPart = {
          functionResponse: {
            name: funcName,
            response: { result: mergedContent },
            id: block.tool_use_id,
          },
        };
        // Keep a tool round contiguous: all function responses are emitted
        // first, followed by their media in source order. Interleaving
        // response→image→response→image makes parallel calls ambiguous to
        // providers that associate media with the immediately preceding
        // response.
        deferredToolResponses.push(part);
        deferredToolMedia.push(...extraParts);
      } else if (block.type === 'redacted_thinking') {
        parts.push({ text: `[Redacted Thinking: ${block.data}]`, thought: true });
      }
    }
    parts.push(...deferredToolResponses, ...deferredToolMedia);
    if (parts.length > 0) {
      if (protectedMediaContents && currentUserIndex >= 0 && i >= currentUserIndex) {
        protectedMediaContents.add(contents.length);
      }
      contents.push({ role, parts });
    }
  }

  if (missingSignature) {
    logger.warn(
      `[ThoughtSig] No matching historical signature; leaving unsigned tool call for model=${missingSignature.model} toolCallId=${missingSignature.toolCallId}`,
    );
  }

  return contents;
}
