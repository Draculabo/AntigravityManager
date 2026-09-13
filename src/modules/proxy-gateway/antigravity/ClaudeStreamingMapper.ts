import {
  FunctionCall,
  GeminiPart,
  GeminiResponse,
  GroundingChunk,
  Usage,
  UsageMetadata,
} from './types';
import { SignatureStore } from './SignatureStore';
import { decodeSignature } from './signature-utils';
import { toAnthropicMessageId } from './anthropic-message-id';
import { logger } from '@/shared/logging/logger';

type BlockType = 'None' | 'Text' | 'Thinking' | 'Function';

interface StreamToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  signature?: string;
}

type StreamContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | StreamToolUseContentBlock;

type StreamDelta =
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

interface StreamMessageStart {
  id: string;
  type: 'message';
  role: 'assistant';
  content: [];
  model: string;
  stop_reason: null;
  stop_sequence: null;
  usage: Usage;
}

interface StreamErrorPayload {
  type: 'network_error';
  message: string;
  code: 'stream_decode_error';
  details: {
    error_count: number;
    suggestion: string;
  };
}

interface StreamSseEventPayloads {
  message_start: { type: 'message_start'; message: StreamMessageStart };
  content_block_start: {
    type: 'content_block_start';
    index: number;
    content_block: StreamContentBlock;
  };
  content_block_stop: { type: 'content_block_stop'; index: number };
  content_block_delta: { type: 'content_block_delta'; index: number; delta: StreamDelta };
  message_delta: {
    type: 'message_delta';
    delta: { stop_reason: string; stop_sequence: null };
    usage: Usage;
  };
  error: { type: 'error'; error: StreamErrorPayload };
}

interface SignatureManager {
  pending: string | null;
}

class SignatureManagerImpl implements SignatureManager {
  pending: string | null = null;

  store(signature?: string) {
    if (signature) {
      this.pending = signature;
    }
  }

  consume(): string | null {
    const s = this.pending;
    this.pending = null;
    return s;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }
}

/**
 * Streaming State Machine
 */
export class StreamingState {
  private blockType: BlockType = 'None';
  public blockIndex: number = 0;
  public messageStartSent: boolean = false;
  public messageStopSent: boolean = false;
  public hasThinking: boolean = false;
  public hasContent: boolean = false;
  private usedTool: boolean = false;
  private signatures: SignatureManagerImpl = new SignatureManagerImpl();
  public trailingSignature: string | null = null;

  // Web Search / Grounding buffers
  public webSearchQuery: string | null = null;
  public groundingChunks: GroundingChunk[] | null = null;

  private parseErrorCount: number = 0;
  private registeredToolNames: readonly string[] = [];
  private textDeltaEmittedThisTurn: boolean = false;

  constructor(
    public readonly signatureContext: {
      model?: string;
      family?: string | null;
      familyModel?: string | null;
      sessionKey?: string;
      messageCount?: number;
    } = {},
  ) {}

  public emit<EventType extends keyof StreamSseEventPayloads>(
    eventType: EventType,
    data: StreamSseEventPayloads[EventType],
  ): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  public emitMessageStart(response: GeminiResponse, fallbackUsage?: Usage): string {
    if (this.messageStartSent) return '';

    const usageMeta = response.usageMetadata;
    const usage: Usage = usageMeta
      ? {
          input_tokens: usageMeta.total_input_tokens ?? usageMeta.promptTokenCount ?? 0,
          output_tokens: usageMeta.total_output_tokens ?? usageMeta.candidatesTokenCount ?? 0,
          cache_read_input_tokens:
            usageMeta.total_cached_tokens ??
            usageMeta.cachedContentTokenCount ??
            usageMeta.cachedTokens ??
            0,
          reasoning_tokens:
            usageMeta.total_thought_tokens ??
            usageMeta.totalThoughtTokens ??
            usageMeta.thoughtsTokenCount ??
            0,
        }
      : (fallbackUsage ?? { input_tokens: 0, output_tokens: 0 });

    const message: StreamMessageStart = {
      id: toAnthropicMessageId(response.responseId),
      type: 'message',
      role: 'assistant',
      content: [],
      model: response.modelVersion || '',
      stop_reason: null,
      stop_sequence: null,
      usage: usage,
    };

    this.messageStartSent = true;

    return this.emit('message_start', {
      type: 'message_start',
      message: message,
    });
  }

  public startBlock(blockType: BlockType, contentBlock: StreamContentBlock): string[] {
    const chunks: string[] = [];
    if (this.blockType !== 'None') {
      chunks.push(...this.endBlock());
    }

    chunks.push(
      this.emit('content_block_start', {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: contentBlock,
      }),
    );

    this.blockType = blockType;
    return chunks;
  }

  public endBlock(): string[] {
    if (this.blockType === 'None') {
      return [];
    }

    const chunks: string[] = [];

    // Send stored signature when Thinking block ends
    if (this.blockType === 'Thinking' && this.signatures.hasPending()) {
      const sig = this.signatures.consume();
      if (sig) {
        // emit_delta "signature_delta"
        chunks.push(this.emitDelta({ type: 'signature_delta', signature: sig }));
      }
    }

    chunks.push(
      this.emit('content_block_stop', {
        type: 'content_block_stop',
        index: this.blockIndex,
      }),
    );

    this.blockIndex++;
    this.blockType = 'None';

    return chunks;
  }

  public emitDelta(delta: StreamDelta): string {
    return this.emit('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: delta,
    });
  }

  public emitFinish(finishReason?: string, usageMetadata?: UsageMetadata): string[] {
    const chunks: string[] = [];

    // Close last block
    chunks.push(...this.endBlock());

    // Process trailing signature (PDF 776-778 logic)
    if (this.trailingSignature) {
      const sig = this.trailingSignature;
      this.trailingSignature = null;

      chunks.push(
        this.emit('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );

      chunks.push(this.emitDelta({ type: 'thinking_delta', thinking: '' }));
      chunks.push(this.emitDelta({ type: 'signature_delta', signature: sig }));

      chunks.push(
        this.emit('content_block_stop', {
          type: 'content_block_stop',
          index: this.blockIndex,
        }),
      );
      this.blockIndex++;
      this.hasThinking = true;
    }

    // Process grounding (web search) -> convert to Markdown text block
    let groundingText = '';
    if (this.webSearchQuery) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${this.webSearchQuery}`;
    }
    if (this.groundingChunks && this.groundingChunks.length > 0) {
      const links: string[] = [];
      this.groundingChunks.forEach((chunk, i) => {
        if (chunk.web) {
          const title = chunk.web.title || 'Web source';
          const uri = chunk.web.uri || '#';
          links.push(`[${i + 1}] [${title}](${uri})`);
        }
      });
      if (links.length > 0) {
        groundingText += `\n\n**🌐 Citations:**\n` + links.join('\n');
      }
    }

    if (groundingText) {
      chunks.push(
        this.emit('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'text', text: '' },
        }),
      );
      chunks.push(this.emitDelta({ type: 'text_delta', text: groundingText }));
      chunks.push(
        this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
      );
      this.blockIndex++;
      this.hasContent = true;
    }

    const recoveredEmptyResponse = !this.hasContent && !this.hasThinking;
    if (recoveredEmptyResponse) {
      if (!this.messageStartSent) {
        chunks.push(
          this.emitMessageStart(
            { modelVersion: 'gemini-auto' },
            { input_tokens: 0, output_tokens: 0 },
          ),
        );
      }

      chunks.push(...this.startBlock('Text', { type: 'text', text: '.' }));
      chunks.push(...this.endBlock());
      this.hasContent = true;
    }

    // Determine stop reason
    const stopReason = recoveredEmptyResponse
      ? 'end_turn'
      : this.usedTool
        ? 'tool_use'
        : finishReason === 'MAX_TOKENS'
          ? 'max_tokens'
          : 'end_turn';

    const usage: Usage = recoveredEmptyResponse
      ? { input_tokens: 1, output_tokens: 1 }
      : usageMetadata
        ? {
            input_tokens: usageMetadata.total_input_tokens ?? usageMetadata.promptTokenCount ?? 0,
            output_tokens:
              usageMetadata.total_output_tokens ?? usageMetadata.candidatesTokenCount ?? 0,
            cache_read_input_tokens:
              usageMetadata.total_cached_tokens ??
              usageMetadata.cachedContentTokenCount ??
              usageMetadata.cachedTokens ??
              0,
            reasoning_tokens:
              usageMetadata.total_thought_tokens ??
              usageMetadata.totalThoughtTokens ??
              usageMetadata.thoughtsTokenCount ??
              0,
          }
        : { input_tokens: 0, output_tokens: 0 };

    chunks.push(
      this.emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usage,
      }),
    );

    if (!this.messageStopSent) {
      chunks.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      this.messageStopSent = true;
    }

    return chunks;
  }

  public markToolUsed() {
    this.usedTool = true;
    this.hasContent = true;
  }

  public setRegisteredToolNames(names: readonly string[]): void {
    this.registeredToolNames = [...names];
  }

  public findRegisteredToolName(name: string): string | undefined {
    return this.registeredToolNames.find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
  }

  public hasRegisteredToolNames(): boolean {
    return this.registeredToolNames.length > 0;
  }

  public hasUsedTool(): boolean {
    return this.usedTool;
  }

  public hasEmittedTextDelta(): boolean {
    return this.textDeltaEmittedThisTurn;
  }

  public markTextDeltaEmitted(): void {
    this.textDeltaEmittedThisTurn = true;
  }

  public currentBlockType(): BlockType {
    return this.blockType;
  }

  public storeSignature(signature?: string) {
    this.signatures.store(signature);
  }

  public persistSignature(signature: string, toolCallId?: string): void {
    if (!this.signatureContext.model) {
      return;
    }
    SignatureStore.store({
      signature,
      model: this.signatureContext.model,
      family: this.signatureContext.family,
      familyModel: this.signatureContext.familyModel,
      sessionKey: this.signatureContext.sessionKey,
      messageCount: this.signatureContext.messageCount,
      toolCallId,
    });
  }
  public handleParseError(rawData: string): string[] {
    const chunks: string[] = [];
    this.parseErrorCount++;

    logger.warn(
      `[SSE-Parser] Parse error #${this.parseErrorCount}. Raw data length: ${rawData.length}`,
    );

    // Safely close current block
    if (this.blockType !== 'None') {
      chunks.push(...this.endBlock());
    }

    // Emit error event if too many errors
    if (this.parseErrorCount > 3) {
      logger.error(
        `[SSE-Parser] High error rate (${this.parseErrorCount} errors). Stream may be corrupted.`,
      );
      chunks.push(
        this.emit('error', {
          type: 'error',
          error: {
            type: 'network_error',
            message: 'Unstable network connection. Please check your network or proxy settings.',
            code: 'stream_decode_error',
            details: {
              error_count: this.parseErrorCount,
              suggestion: 'Check network connection',
            },
          },
        }),
      );
    }

    return chunks;
  }

  /**
   * Reset error state (call after recovery)
   */
  public resetErrorState(): void {
    this.parseErrorCount = 0;
  }

  /**
   * Get current error count (for monitoring)
   */
  public getErrorCount(): number {
    return this.parseErrorCount;
  }
}

/**
 * Part Processor
 */
export class PartProcessor {
  constructor(private state: StreamingState) {}

  public process(part: GeminiPart): string[] {
    const chunks: string[] = [];
    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
    if (signature) {
      this.state.persistSignature(signature);
    }

    // 1. Handle FunctionCall
    if (part.functionCall) {
      // Handle trailing signature logic
      if (this.state.trailingSignature) {
        chunks.push(...this.state.endBlock());
        const trailingSig = this.state.trailingSignature;
        this.state.trailingSignature = null;

        chunks.push(
          this.state.emit('content_block_start', {
            type: 'content_block_start',
            index: this.state.blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }),
        );
        chunks.push(this.state.emitDelta({ type: 'thinking_delta', thinking: '' }));
        chunks.push(this.state.emitDelta({ type: 'signature_delta', signature: trailingSig }));
        chunks.push(...this.state.endBlock());
        this.state.hasThinking = true;
      }

      chunks.push(...this.processFunctionCall(part.functionCall, signature));
      return chunks;
    }

    // 2. Handle Text
    if (part.text !== undefined) {
      if (part.thought) {
        chunks.push(...this.processThinking(part.text, signature));
      } else {
        chunks.push(...this.processText(part.text, signature));
      }
    }

    // 3. InlineData (Image)
    if (part.inlineData) {
      const { mimeType, data } = part.inlineData;
      if (data) {
        const markdownImg = `![image](data:${mimeType};base64,${data})`;
        chunks.push(...this.processText(markdownImg, undefined));
      }
    }

    return chunks;
  }

  private processThinking(text: string, signature?: string): string[] {
    const chunks: string[] = [];

    // Handle trailing signature
    if (this.state.trailingSignature) {
      chunks.push(...this.state.endBlock());
      const trailingSig = this.state.trailingSignature;
      this.state.trailingSignature = null;

      chunks.push(
        this.state.emit('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      chunks.push(this.state.emitDelta({ type: 'thinking_delta', thinking: '' }));
      chunks.push(this.state.emitDelta({ type: 'signature_delta', signature: trailingSig }));
      chunks.push(...this.state.endBlock());
      this.state.hasThinking = true;
    }

    // A thought with no text and no signature has nothing to put in a block. The
    // unary mapper already refuses to materialise that case (flushThinking), while
    // this path opened a thinking block that carried neither content nor signature
    // and that the client feeds back upstream on the next turn.
    if (!text && !signature) {
      return chunks;
    }

    this.state.hasThinking = true;

    if (this.state.currentBlockType() !== 'Thinking') {
      chunks.push(...this.state.startBlock('Thinking', { type: 'thinking', thinking: '' }));
    }

    if (text) {
      chunks.push(this.state.emitDelta({ type: 'thinking_delta', thinking: text }));
    }

    this.state.storeSignature(signature);

    return chunks;
  }

  private processText(text: string, signature?: string): string[] {
    const chunks: string[] = [];

    // Empty text with signature -> store trailing
    if (!text) {
      if (signature) {
        this.state.trailingSignature = signature;
      }
      return chunks;
    }

    this.state.hasContent = true;

    // Handle trailing signature
    if (this.state.trailingSignature) {
      chunks.push(...this.state.endBlock());
      const trailingSig = this.state.trailingSignature;
      this.state.trailingSignature = null;

      chunks.push(
        this.state.emit('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      chunks.push(this.state.emitDelta({ type: 'thinking_delta', thinking: '' }));
      chunks.push(this.state.emitDelta({ type: 'signature_delta', signature: trailingSig }));
      chunks.push(...this.state.endBlock());
      this.state.hasThinking = true;
    }

    // Non-empty text with signature -> flush immediately
    if (signature) {
      // Start text block
      chunks.push(...this.state.startBlock('Text', { type: 'text', text: '' }));
      chunks.push(this.state.emitDelta({ type: 'text_delta', text: text }));
      chunks.push(...this.state.endBlock());

      // Empty thinking block for signature
      chunks.push(
        this.state.emit('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      chunks.push(this.state.emitDelta({ type: 'thinking_delta', thinking: '' }));
      chunks.push(this.state.emitDelta({ type: 'signature_delta', signature: signature }));
      chunks.push(...this.state.endBlock());
      this.state.hasThinking = true;

      return chunks;
    }

    const recoveredToolCall = this.tryRecoverLeakedToolCall(text);
    if (recoveredToolCall) {
      return [...chunks, ...recoveredToolCall];
    }

    // Normal text
    if (this.state.currentBlockType() !== 'Text') {
      chunks.push(...this.state.startBlock('Text', { type: 'text', text: '' }));
    }
    this.state.markTextDeltaEmitted();
    chunks.push(this.state.emitDelta({ type: 'text_delta', text: text }));

    return chunks;
  }

  private tryRecoverLeakedToolCall(text: string): string[] | null {
    if (!this.state.hasRegisteredToolNames()) {
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

    const registeredToolName = this.state.findRegisteredToolName(toolName);
    if (!registeredToolName || this.state.hasUsedTool() || this.state.hasEmittedTextDelta()) {
      return null;
    }

    const input = this.parseLooseJsonObject(argumentText);
    if (!input) {
      return null;
    }

    logger.warn(`[Claude-SSE] Recovered leaked tool call for ${registeredToolName}`);
    return this.processFunctionCall({ name: registeredToolName, args: input });
  }

  private parseLooseJsonObject(argumentText: string): Record<string, unknown> | null {
    if (!argumentText) {
      return {};
    }

    const parseObject = (value: string): Record<string, unknown> | null => {
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    };

    const strict = parseObject(argumentText);
    if (strict) {
      return strict;
    }

    if (!argumentText.startsWith('{') || !argumentText.endsWith('}')) {
      return null;
    }

    const quotedKeys = argumentText.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/gu, '$1"$2"$3');
    return parseObject(quotedKeys);
  }

  private processFunctionCall(fc: FunctionCall, signature?: string): string[] {
    const chunks: string[] = [];

    this.state.markToolUsed();

    const toolId = fc.id || `${fc.name}-${Math.random().toString(36).substr(2, 9)}`;

    const toolUse: StreamToolUseContentBlock = {
      type: 'tool_use',
      id: toolId,
      name: fc.name,
      input: {}, // Empty, args sent via delta
    };

    if (signature) {
      toolUse.signature = signature;
      this.state.persistSignature(signature, toolId);
    }

    chunks.push(...this.state.startBlock('Function', toolUse));

    // input_json_delta
    if (fc.args) {
      const jsonStr = JSON.stringify(fc.args);
      chunks.push(this.state.emitDelta({ type: 'input_json_delta', partial_json: jsonStr }));
    }

    chunks.push(...this.state.endBlock());

    return chunks;
  }
}
