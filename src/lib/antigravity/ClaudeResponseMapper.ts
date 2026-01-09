import { v4 as uuidv4 } from 'uuid';
import {
  ClaudeResponse,
  GeminiResponse,
  GeminiPart,
  ContentBlock,
  Usage,
  GroundingMetadata,
} from './types';

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

  constructor() {}

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
    const signature = part.thoughtSignature || null;

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

  private processGrounding(grounding: GroundingMetadata) {
    let groundingText = '';

    if (grounding.webSearchQueries && grounding.webSearchQueries.length > 0) {
      groundingText += `\n\n---\n**🔍 已为您搜索：** ${grounding.webSearchQueries.join(', ')}`;
    }

    if (grounding.groundingChunks) {
      const links: string[] = [];
      grounding.groundingChunks.forEach((chunk, index) => {
        if (chunk.web) {
          const title = chunk.web.title || '网页来源';
          const uri = chunk.web.uri || '#';
          links.push(`[${index + 1}] [${title}](${uri})`);
        }
      });

      if (links.length > 0) {
        groundingText += `\n\n**🌐 来源引文：**\n` + links.join('\n');
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
    if (!this.textBuilder) return;
    this.contentBlocks.push({
      type: 'text',
      text: this.textBuilder,
    });
    this.textBuilder = '';
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

    let stopReason = 'end_turn';
    if (this.hasToolCall) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    }

    const usage: Usage = {
      input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
      output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
    };

    return {
      id: geminiResponse.responseId || `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      model: geminiResponse.modelVersion || '',
      content: this.contentBlocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: usage,
    };
  }
}

/**
 * Public API: Transform Gemini Response to Claude Response
 */
export function transformResponse(geminiResponse: GeminiResponse): ClaudeResponse {
  const processor = new NonStreamingProcessor();
  return processor.process(geminiResponse);
}
