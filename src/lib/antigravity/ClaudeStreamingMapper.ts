import { GeminiPart, Usage, UsageMetadata, GroundingMetadata } from './types';
import { SignatureStore } from './SignatureStore';

type BlockType = 'None' | 'Text' | 'Thinking' | 'Function';

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
  private usedTool: boolean = false;
  private signatures: SignatureManagerImpl = new SignatureManagerImpl();
  public trailingSignature: string | null = null;

  // Web Search / Grounding buffers
  public webSearchQuery: string | null = null;
  public groundingChunks: any[] | null = null;

  constructor() {}

  public emit(eventType: string, data: any): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  public emitMessageStart(rawJson: any): string {
    if (this.messageStartSent) return '';

    const usageMeta = rawJson.usageMetadata;
    const usage: Usage | undefined = usageMeta
      ? {
          input_tokens: usageMeta.promptTokenCount || 0,
          output_tokens: usageMeta.candidatesTokenCount || 0,
        }
      : undefined;

    const message = {
      id: rawJson.responseId || 'msg_unknown',
      type: 'message',
      role: 'assistant',
      content: [],
      model: rawJson.modelVersion || '',
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

  public startBlock(blockType: BlockType, contentBlock: any): string[] {
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
        chunks.push(this.emitDelta('signature_delta', { signature: sig }));
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

  public emitDelta(deltaType: string, deltaContent: any): string {
    const delta = { type: deltaType, ...deltaContent };
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

      chunks.push(this.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.emitDelta('signature_delta', { signature: sig }));

      chunks.push(
        this.emit('content_block_stop', {
          type: 'content_block_stop',
          index: this.blockIndex,
        }),
      );
      this.blockIndex++;
    }

    // Process grounding (web search) -> convert to Markdown text block
    let groundingText = '';
    if (this.webSearchQuery) {
      groundingText += `\n\n---\n**🔍 已为您搜索：** ${this.webSearchQuery}`;
    }
    if (this.groundingChunks && this.groundingChunks.length > 0) {
      const links: string[] = [];
      this.groundingChunks.forEach((chunk, i) => {
        if (chunk.web) {
          const title = chunk.web.title || '网页来源';
          const uri = chunk.web.uri || '#';
          links.push(`[${i + 1}] [${title}](${uri})`);
        }
      });
      if (links.length > 0) {
        groundingText += `\n\n**🌐 来源引文：**\n` + links.join('\n');
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
      chunks.push(this.emitDelta('text_delta', { text: groundingText }));
      chunks.push(
        this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
      );
      this.blockIndex++;
    }

    // Determine stop reason
    let stopReason = 'end_turn';
    if (this.usedTool) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    }

    const usage: Usage = usageMetadata
      ? {
          input_tokens: usageMetadata.promptTokenCount || 0,
          output_tokens: usageMetadata.candidatesTokenCount || 0,
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
  }

  public currentBlockType(): BlockType {
    return this.blockType;
  }

  public storeSignature(signature?: string) {
    this.signatures.store(signature);
  }
}

/**
 * Part Processor
 */
export class PartProcessor {
  constructor(private state: StreamingState) {}

  public process(part: GeminiPart): string[] {
    const chunks: string[] = [];
    const signature = part.thoughtSignature || undefined;

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
        chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
        chunks.push(this.state.emitDelta('signature_delta', { signature: trailingSig }));
        chunks.push(...this.state.endBlock());
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
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.state.emitDelta('signature_delta', { signature: trailingSig }));
      chunks.push(...this.state.endBlock());
    }

    if (this.state.currentBlockType() !== 'Thinking') {
      chunks.push(...this.state.startBlock('Thinking', { type: 'thinking', thinking: '' }));
    }

    if (text) {
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: text }));
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
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.state.emitDelta('signature_delta', { signature: trailingSig }));
      chunks.push(...this.state.endBlock());
    }

    // Non-empty text with signature -> flush immediately
    if (signature) {
      // Start text block
      chunks.push(...this.state.startBlock('Text', { type: 'text', text: '' }));
      chunks.push(this.state.emitDelta('text_delta', { text: text }));
      chunks.push(...this.state.endBlock());

      // Empty thinking block for signature
      chunks.push(
        this.state.emit('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.state.emitDelta('signature_delta', { signature: signature }));
      chunks.push(...this.state.endBlock());

      return chunks;
    }

    // Normal text
    if (this.state.currentBlockType() !== 'Text') {
      chunks.push(...this.state.startBlock('Text', { type: 'text', text: '' }));
    }
    chunks.push(this.state.emitDelta('text_delta', { text: text }));

    return chunks;
  }

  private processFunctionCall(
    fc: { name: string; args: any; id?: string },
    signature?: string,
  ): string[] {
    const chunks: string[] = [];

    this.state.markToolUsed();

    const toolId = fc.id || `${fc.name}-${Math.random().toString(36).substr(2, 9)}`;

    const toolUse: any = {
      type: 'tool_use',
      id: toolId,
      name: fc.name,
      input: {}, // Empty, args sent via delta
    };

    if (signature) {
      toolUse.signature = signature;
      // Store signature to global storage for replay in subsequent requests
      SignatureStore.store(signature);
    }

    chunks.push(...this.state.startBlock('Function', toolUse));

    // input_json_delta
    if (fc.args) {
      const jsonStr = JSON.stringify(fc.args);
      chunks.push(this.state.emitDelta('input_json_delta', { partial_json: jsonStr }));
    }

    chunks.push(...this.state.endBlock());

    return chunks;
  }
}
