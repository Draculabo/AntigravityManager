import { v4 as uuidv4 } from 'uuid';
import {
  ClaudeResponse,
  GeminiResponse,
  GeminiPart,
  ContentBlock,
  Usage,
  GroundingMetadata,
} from './types';
import { decodeSignature } from './signature-utils';
import { toAnthropicMessageId } from './anthropic-message-id';
import { SignatureStore } from './SignatureStore';
import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
} from './GeminiFinishReason';
import type { ThoughtSignatureModelContext } from './thought-signature-model';
import { logger } from '@/shared/logging/logger';

export interface ClaudeResponseMapperOptions extends Partial<ThoughtSignatureModelContext> {
  registeredToolNames?: readonly string[];
  signatureSessionKey?: string;
  signatureMessageCount?: number;
}

/**
 * Non-streaming response processor (Gemini -> Claude)
 *
 */
class NonStreamingProcessor {
  private contentBlocks: ContentBlock[] = [];
  private textBuilder: string = '';
  private thinkingBuilder: string = '';
  private thinkingSignature: string | null = null;
  private trailingSignature: string | null = null;
  private hasToolCall: boolean = false;

  constructor(private readonly options: ClaudeResponseMapperOptions = {}) {}

  public process(geminiResponse: GeminiResponse): ClaudeResponse {
    const candidate = geminiResponse.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // 1. Process all parts
    for (const part of parts) {
      this.processPart(part);
    }

    // 2. Process grounding (web search)
    if (candidate?.groundingMetadata) {
      this.processGrounding(candidate.groundingMetadata);
    }

    // 3. Flush remaining content
    this.flushThinking();
    this.flushText();

    // 4. Handle trailingSignature
    if (this.trailingSignature) {
      this.contentBlocks.push({
        type: 'thinking',
        thinking: '',
        signature: this.trailingSignature,
      });
      this.trailingSignature = null; // Consumed
    }

    // 5. Build response
    return this.buildResponse(geminiResponse);
  }

  private processPart(part: GeminiPart) {
    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature) || null;

    // 1. Handle FunctionCall
    if (part.functionCall) {
      this.flushThinking();
      this.flushText();

      // Handle trailing signature logic
      if (this.trailingSignature) {
        this.contentBlocks.push({
          type: 'thinking',
          thinking: '',
          signature: this.trailingSignature,
        });
        this.trailingSignature = null;
      }

      this.hasToolCall = true;

      const fc = part.functionCall;
      const toolId = fc.id || `${fc.name}-${uuidv4()}`;

      if (signature) {
        this.storeSignature(signature, toolId);
      }

      const toolUse: ContentBlock = {
        type: 'tool_use',
        id: toolId,
        name: fc.name,
        input: fc.args || {},
        signature: signature || undefined,
      };

      this.contentBlocks.push(toolUse);
      return;
    }

    if (signature) {
      this.storeSignature(signature);
    }

    // 2. Handle Text / Thinking
    if (part.text !== undefined) {
      const text = part.text;
      if (part.thought) {
        // Thinking Part
        this.flushText();

        // Handle trailing signature before thinking
        if (this.trailingSignature) {
          this.flushThinking(); // Ensure previous thinking is flushed
          this.contentBlocks.push({
            type: 'thinking',
            thinking: '',
            signature: this.trailingSignature,
          });
          this.trailingSignature = null;
        }

        this.thinkingBuilder += text;
        if (signature) {
          this.thinkingSignature = signature;
        }
      } else {
        // Normal Text
        if (text === '') {
          // Empty text with signature -> store as trailing
          if (signature) {
            this.trailingSignature = signature;
          }
          return;
        }

        this.flushThinking();

        // Handle trailing signature
        if (this.trailingSignature) {
          this.flushText();
          this.contentBlocks.push({
            type: 'thinking',
            thinking: '',
            signature: this.trailingSignature,
          });
          this.trailingSignature = null;
        }

        this.textBuilder += text;

        // Non-empty text with signature -> flush immediately empty thinking block with sig
        if (signature) {
          this.flushText();
          this.contentBlocks.push({
            type: 'thinking',
            thinking: '',
            signature: signature,
          });
        }
      }
    }

    // 3. Handle InlineData (Image)
    if (part.inlineData) {
      this.flushThinking();
      const { mimeType, data } = part.inlineData;
      if (data) {
        const markdownImg = `![image](data:${mimeType};base64,${data})`;
        this.textBuilder += markdownImg;
        this.flushText();
      }
    }
  }

  private storeSignature(signature: string, toolCallId?: string): void {
    if (!this.options.model) {
      return;
    }
    SignatureStore.store({
      signature,
      model: this.options.model,
      family: this.options.family,
      familyModel: this.options.familyModel,
      sessionKey: this.options.signatureSessionKey,
      messageCount: this.options.signatureMessageCount,
      toolCallId,
    });
  }

  private processGrounding(grounding: GroundingMetadata) {
    let groundingText = '';

    if (grounding.webSearchQueries && grounding.webSearchQueries.length > 0) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${grounding.webSearchQueries.join(', ')}`;
    }

    if (grounding.groundingChunks) {
      const links: string[] = [];
      grounding.groundingChunks.forEach((chunk, index) => {
        if (chunk.web) {
          const title = chunk.web.title || 'Web source';
          const uri = chunk.web.uri || '#';
          links.push(`[${index + 1}] [${title}](${uri})`);
        }
      });

      if (links.length > 0) {
        groundingText += `\n\n**🌐 Citations:**\n` + links.join('\n');
      }
    }

    if (groundingText) {
      this.flushThinking();
      this.flushText();
      this.textBuilder += groundingText;
      this.flushText();
    }
  }

  private flushText() {
    if (!this.textBuilder) {
      return;
    }

    const text = this.textBuilder;
    this.textBuilder = '';
    const recoveredToolCall = this.recoverLeakedToolCall(text);
    if (recoveredToolCall) {
      this.contentBlocks.push(recoveredToolCall);
      this.hasToolCall = true;
      return;
    }

    this.contentBlocks.push({
      type: 'text',
      text,
    });
  }

  private recoverLeakedToolCall(text: string): ContentBlock | null {
    const registeredToolNames = this.options.registeredToolNames;
    if (!registeredToolNames || registeredToolNames.length === 0) {
      return null;
    }

    const prefix = 'call:default_api:';
    const trimmed = text.trim();
    if (!trimmed.startsWith(prefix)) {
      return null;
    }

    const rest = trimmed.slice(prefix.length);
    const delimiterIndex = rest.search(/[({]/u);
    const toolNameEnd = delimiterIndex === -1 ? rest.length : delimiterIndex;
    const toolName = rest.slice(0, toolNameEnd).trim();
    if (!toolName) {
      return null;
    }

    const argumentText = rest.slice(toolNameEnd).trim();
    if (argumentText && !argumentText.startsWith('{') && !argumentText.startsWith('(')) {
      return null;
    }

    const registeredToolName = registeredToolNames.find(
      (candidate) => candidate.toLowerCase() === toolName.toLowerCase(),
    );
    if (!registeredToolName) {
      return null;
    }

    let input: Record<string, unknown> = {};
    if (argumentText) {
      try {
        const parsed: unknown = JSON.parse(argumentText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return null;
        }
        input = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    }

    logger.warn(`[Claude-Response] Recovered leaked tool call for ${registeredToolName}`);
    return {
      type: 'tool_use',
      id: `${registeredToolName}-${uuidv4()}`,
      name: registeredToolName,
      input,
    };
  }

  private flushThinking() {
    if (!this.thinkingBuilder && !this.thinkingSignature) return;

    this.contentBlocks.push({
      type: 'thinking',
      thinking: this.thinkingBuilder,
      signature: this.thinkingSignature || undefined,
    });

    this.thinkingBuilder = '';
    this.thinkingSignature = null;
  }

  private buildResponse(geminiResponse: GeminiResponse): ClaudeResponse {
    const finishReason = geminiResponse.candidates?.[0]?.finishReason;
    const isMalformedFunctionCall = isMalformedFunctionCallFinishReason(finishReason);
    const blockReason = geminiResponse.promptFeedback?.blockReason;
    const refusal = blockReason
      ? `Request blocked by safety policy (blockReason: ${blockReason})`
      : undefined;

    let stopReason = 'end_turn';
    if (!isMalformedFunctionCall && this.hasToolCall) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    } else if (refusal) {
      stopReason = 'content_filter';
    }

    const usage: Usage = {
      input_tokens:
        geminiResponse.usageMetadata?.total_input_tokens ??
        geminiResponse.usageMetadata?.promptTokenCount ??
        0,
      output_tokens:
        geminiResponse.usageMetadata?.total_output_tokens ??
        geminiResponse.usageMetadata?.candidatesTokenCount ??
        0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:
        geminiResponse.usageMetadata?.total_cached_tokens ??
        geminiResponse.usageMetadata?.cachedContentTokenCount ??
        geminiResponse.usageMetadata?.cachedTokens ??
        0,
      reasoning_tokens:
        geminiResponse.usageMetadata?.total_thought_tokens ??
        geminiResponse.usageMetadata?.totalThoughtTokens ??
        geminiResponse.usageMetadata?.thoughtsTokenCount ??
        0,
    };

    const hasVisibleText = this.contentBlocks.some(
      (contentBlock) => contentBlock.type === 'text' && contentBlock.text.trim().length > 0,
    );
    if (isMalformedFunctionCall && !hasVisibleText) {
      this.contentBlocks.push({ type: 'text', text: MALFORMED_FUNCTION_CALL_RECOVERY_TEXT });
    } else if (this.contentBlocks.length === 0) {
      this.contentBlocks.push({ type: 'text', text: '.' });
    }

    return {
      id: toAnthropicMessageId(geminiResponse.responseId),
      type: 'message',
      role: 'assistant',
      model: geminiResponse.modelVersion || '',
      content: this.contentBlocks,
      stop_reason: stopReason,
      usage: usage,
      refusal,
    };
  }
}

/**
 * Public API: Transform Gemini Response to Claude Response
 */
export function transformResponse(
  geminiResponse: GeminiResponse,
  options: ClaudeResponseMapperOptions = {},
): ClaudeResponse {
  const processor = new NonStreamingProcessor(options);
  return processor.process(geminiResponse);
}
