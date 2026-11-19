import { randomUUID } from 'node:crypto';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { ResponseToolCallIdentity } from '@/modules/proxy-gateway/antigravity/ResponseToolCallIdentity';
import { hashSessionAnchor } from '../../../common/session-anchor-hash';
import type {
  GenerationStreamGrounding,
  GenerationStreamPart,
  GenerationStreamToolCall,
} from '@/modules/proxy-gateway/antigravity/AntigravityStreamDecoder';
import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
} from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { toIncompleteReason, type ResponsesOutputStatus } from './openai-responses-incomplete';
import type { OpenAIResponsesUsage } from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import type { OpenAITool } from '../../../common/interfaces/request-interfaces';
import {
  createResponsesToolCallProjection,
  type ResponsesToolCallOutputItem,
} from './responses-tool-call-projection';
interface ResponsesMessageOutputItem {
  content: Array<{
    annotations: [];
    text: string;
    type: 'output_text';
  }>;
  id: string;
  phase: 'commentary' | 'final_answer';
  role: 'assistant';
  status: ResponsesOutputStatus;
  type: 'message';
}
interface ResponsesReasoningOutputItem {
  id: string;
  status: ResponsesOutputStatus;
  summary: Array<{
    text: string;
    type: 'summary_text';
  }>;
  type: 'reasoning';
}
type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesReasoningOutputItem
  | ResponsesToolCallOutputItem;
interface ActiveMessageOutput {
  item: ResponsesMessageOutputItem;
  itemId: string;
  outputIndex: number;
  text: string;
}
interface ActiveReasoningOutput {
  item: ResponsesReasoningOutputItem;
  itemId: string;
  outputIndex: number;
  text: string;
}

export interface SerializedResponsesFrame {
  sse: string;
  json: string;
  completedState?: { id: string; output: ResponsesOutputItem[] };
}
interface OpenAIResponsesStreamingMapperOptions {
  toolCallIdentity?: ResponseToolCallIdentity;
  onSerializedFrame?: (frame: SerializedResponsesFrame) => void;
  clientTools?: OpenAITool[];
  model: string;
  responseId: string;
  signatureMessageCount?: number;
  signatureSessionKey?: string;
  signatureSourceModel?: string;
  signatureSourceFamily?: string | null;
  signatureSourceFamilyModel?: string | null;
}
/** Operations are single-use iterators: drain or close one before starting another. */
export class OpenAIResponsesStreamingMapper {
  private readonly emittedToolCallIds = new Set<string>();
  private readonly itemIdPrefix = randomUUID().replaceAll('-', '').slice(0, 16);
  private readonly outputItems: ResponsesOutputItem[] = [];
  private activeMessage: ActiveMessageOutput | null = null;
  private activeThought: ActiveReasoningOutput | null = null;
  private completed = false;
  private hasSeenRegularText = false;
  private hasToolCall = false;
  private messageCounter = 0;
  private nextOutputIndex = 0;
  private sequenceNumber = 0;
  private usage: OpenAIResponsesUsage | undefined;
  private toolCallPosition = 0;
  private readonly toolCallIdentity: ResponseToolCallIdentity;

  constructor(private readonly options: OpenAIResponsesStreamingMapperOptions) {
    this.toolCallIdentity =
      options.toolCallIdentity ??
      new ResponseToolCallIdentity(() => hashSessionAnchor([options.model, options.responseId]));
  }
  public createResponseCreatedEvent(): string {
    return this.serialize({
      response: {
        id: this.options.responseId,
        model: this.options.model,
        object: 'response',
        output: [],
        status: 'in_progress',
      },
      type: 'response.created',
    });
  }
  public createResponseInProgressEvent(): string {
    return this.serialize({
      response: {
        id: this.options.responseId,
        model: this.options.model,
        object: 'response',
        output: [],
        status: 'in_progress',
      },
      type: 'response.in_progress',
    });
  }
  public *processPart(part: GenerationStreamPart): Generator<string> {
    if (this.completed) {
      return;
    }

    const { signature } = part;
    if (part.toolCall?.name) {
      yield* this.processFunctionCall(part.toolCall, signature);
      return;
    }
    if (signature) {
      this.storeSignature(signature);
    }
    if (part.reasoning && part.text) {
      yield* this.processThought(part.text);
      return;
    }
    if (part.media?.data && part.media.mimeType !== undefined) {
      const mimeType = part.media.mimeType || 'image/jpeg';
      yield* this.processText(
        `\n\n![Generated Image](data:${mimeType};base64,${part.media.data})\n\n`,
      );
      return;
    }
    if (part.text) {
      yield* this.processText(part.text);
    }
  }
  public *processGrounding(grounding: GenerationStreamGrounding): Generator<string> {
    let groundingText = '';
    if (grounding.queries?.length) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${grounding.queries.join(', ')}`;
    }
    if (grounding.sources?.length) {
      const links = grounding.sources.map((source, index) => {
        const title = source.title || 'Web source';
        const uri = source.uri || '#';
        return `[${index + 1}] [${title}](${uri})`;
      });
      groundingText += `\n\n**🌐 Citations:**\n${links.join('\n')}`;
    }
    if (groundingText) {
      yield* this.processText(groundingText);
    }
  }
  public setUsage(usage: OpenAIResponsesUsage): void {
    this.usage = usage;
  }
  public *complete(finishReason?: string | null): Generator<string> {
    if (this.completed) {
      return;
    }
    if (isMalformedFunctionCallFinishReason(finishReason)) {
      yield* this.processText(
        `${this.hasSeenRegularText ? '\n\n' : ''}${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}`,
      );
    }
    this.completed = true;
    // An answer upstream cut short is not a finished answer, and a client that is
    // told `completed` has no way to know it should continue.
    const incompleteReason = toIncompleteReason(finishReason);
    const status: ResponsesOutputStatus = incompleteReason ? 'incomplete' : 'completed';
    yield* this.closeThought(status);
    yield* this.closeMessage(this.hasToolCall ? 'commentary' : 'final_answer', status);
    yield this.serialize(
      {
        response: {
          id: this.options.responseId,
          incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
          model: this.options.model,
          object: 'response',
          output: this.outputItems,
          status,
          usage: this.usage,
        },
        type: incompleteReason ? 'response.incomplete' : 'response.completed',
      },
      incompleteReason ? undefined : { id: this.options.responseId, output: this.outputItems },
    );
  }
  public *fail(code: string, message: string): Generator<string> {
    if (this.completed) {
      return;
    }
    this.completed = true;
    yield* this.closeThought('incomplete');
    yield* this.closeMessage(this.hasToolCall ? 'commentary' : 'final_answer', 'incomplete');
    yield this.serialize({
      response: {
        error: { code, message },
        id: this.options.responseId,
        incomplete_details: null,
        model: this.options.model,
        object: 'response',
        output: this.outputItems,
        status: 'failed',
        usage: this.usage,
      },
      type: 'response.failed',
    });
  }
  private *startMessage(): Generator<string> {
    if (this.activeMessage) {
      return;
    }
    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId = `msg_${this.itemIdPrefix}_${this.messageCounter}`;
    this.messageCounter += 1;
    const item: ResponsesMessageOutputItem = {
      content: [{ annotations: [], text: '', type: 'output_text' }],
      id: itemId,
      phase: 'commentary',
      role: 'assistant',
      status: 'completed',
      type: 'message',
    };
    const activeOutput: ActiveMessageOutput = {
      item,
      itemId,
      outputIndex,
      text: '',
    };
    this.activeMessage = activeOutput;
    this.outputItems.push(item);
    yield this.serialize({
      item: {
        content: [],
        id: itemId,
        phase: 'commentary',
        role: 'assistant',
        status: 'in_progress',
        type: 'message',
      },
      output_index: outputIndex,
      type: 'response.output_item.added',
    });
    yield this.serialize({
      content_index: 0,
      item_id: itemId,
      output_index: outputIndex,
      part: {
        annotations: [],
        text: '',
        type: 'output_text',
      },
      type: 'response.content_part.added',
    });
  }
  private *startThought(): Generator<string> {
    if (this.activeThought) {
      return;
    }
    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId = `rs_${this.itemIdPrefix}_${this.messageCounter}`;
    this.messageCounter += 1;
    const item: ResponsesReasoningOutputItem = {
      id: itemId,
      status: 'completed',
      summary: [],
      type: 'reasoning',
    };
    const activeOutput: ActiveReasoningOutput = {
      item,
      itemId,
      outputIndex,
      text: '',
    };
    this.activeThought = activeOutput;
    this.outputItems.push(item);
    yield this.serialize({
      item: {
        id: itemId,
        status: 'in_progress',
        summary: [],
        type: 'reasoning',
      },
      output_index: outputIndex,
      type: 'response.output_item.added',
    });
    yield this.serialize({
      item_id: itemId,
      output_index: outputIndex,
      part: {
        text: '',
        type: 'summary_text',
      },
      summary_index: 0,
      type: 'response.reasoning_summary_part.added',
    });
  }
  private *closeThought(status: ResponsesOutputStatus = 'completed'): Generator<string> {
    const thought = this.activeThought;
    if (!thought) {
      return;
    }
    this.activeThought = null;
    yield* this.finishThought(thought, status);
  }
  private *closeMessage(
    phase: 'commentary' | 'final_answer',
    status: ResponsesOutputStatus = 'completed',
  ): Generator<string> {
    const message = this.activeMessage;
    if (!message) {
      return;
    }
    this.activeMessage = null;
    yield* this.finishMessage(message, phase, status);
  }
  private *finishMessage(
    message: ActiveMessageOutput,
    phase: 'commentary' | 'final_answer',
    status: ResponsesOutputStatus = 'completed',
  ): Generator<string> {
    message.item.content = [{ annotations: [], text: message.text, type: 'output_text' }];
    message.item.phase = phase;
    message.item.status = status;
    yield this.serialize({
      content_index: 0,
      item_id: message.itemId,
      output_index: message.outputIndex,
      text: message.text,
      type: 'response.output_text.done',
    });
    yield this.serialize({
      content_index: 0,
      item_id: message.itemId,
      output_index: message.outputIndex,
      part: {
        annotations: [],
        text: message.text,
        type: 'output_text',
      },
      type: 'response.content_part.done',
    });
    yield this.serialize({
      item: message.item,
      output_index: message.outputIndex,
      type: 'response.output_item.done',
    });
  }
  private *finishThought(
    thought: ActiveReasoningOutput,
    status: ResponsesOutputStatus = 'completed',
  ): Generator<string> {
    const summaryPart = { text: thought.text, type: 'summary_text' as const };
    thought.item.status = status;
    thought.item.summary = [summaryPart];
    yield this.serialize({
      item_id: thought.itemId,
      output_index: thought.outputIndex,
      summary_index: 0,
      text: thought.text,
      type: 'response.reasoning_summary_text.done',
    });
    yield this.serialize({
      item_id: thought.itemId,
      output_index: thought.outputIndex,
      part: summaryPart,
      summary_index: 0,
      type: 'response.reasoning_summary_part.done',
    });
    yield this.serialize({
      item: thought.item,
      output_index: thought.outputIndex,
      type: 'response.output_item.done',
    });
  }
  private *processFunctionCall(
    functionCall: GenerationStreamToolCall,
    signature: string | undefined,
  ): Generator<string> {
    const callId = this.toolCallIdentity.resolve(
      functionCall.name,
      functionCall.arguments,
      this.toolCallPosition,
      functionCall.id,
    );
    if (signature) {
      this.storeSignature(signature, callId, functionCall.name);
    }
    if (functionCall.id && this.emittedToolCallIds.has(callId)) {
      return;
    }
    this.toolCallPosition += 1;
    if (functionCall.id) {
      this.emittedToolCallIds.add(callId);
    }
    const outputIndex = this.nextOutputIndex;
    const projection = createResponsesToolCallProjection(
      functionCall,
      callId,
      `item_${this.options.responseId}_${outputIndex}`,
      outputIndex,
      this.options.clientTools,
    );
    this.nextOutputIndex += 1;
    this.outputItems.push(projection.completedItem);
    this.hasToolCall = true;
    yield* this.closeThought();
    yield* this.closeMessage('commentary');
    for (const event of projection.events()) {
      yield this.serialize(event);
    }
  }
  private storeSignature(signature: string, toolCallId?: string, toolName?: string): void {
    if (!this.options.signatureSourceModel) {
      return;
    }
    SignatureStore.store({
      signature,
      model: this.options.signatureSourceModel,
      family: this.options.signatureSourceFamily,
      familyModel: this.options.signatureSourceFamilyModel,
      sessionKey: this.options.signatureSessionKey,
      messageCount: this.options.signatureMessageCount,
      toolCallId,
      toolName,
    });
  }
  private *processText(text: string): Generator<string> {
    yield* this.closeThought();
    yield* this.startMessage();
    const message = this.activeMessage;
    if (!message) {
      throw new Error('Responses text item failed to start');
    }
    this.hasSeenRegularText = true;
    message.text += text;
    yield this.serialize({
      content_index: 0,
      delta: text,
      item_id: message.itemId,
      output_index: message.outputIndex,
      type: 'response.output_text.delta',
    });
  }
  private *processThought(text: string): Generator<string> {
    const cleanText = text
      .replaceAll('<think>\n', '')
      .replaceAll('<think>', '')
      .replaceAll('\n</think>', '')
      .replaceAll('</think>', '');
    if (!cleanText || this.hasSeenRegularText) {
      return;
    }
    yield* this.startThought();
    const thought = this.activeThought;
    if (!thought) {
      throw new Error('Responses thought item failed to start');
    }
    thought.text += cleanText;
    yield this.serialize({
      delta: cleanText,
      item_id: thought.itemId,
      output_index: thought.outputIndex,
      summary_index: 0,
      type: 'response.reasoning_summary_text.delta',
    });
  }
  private serialize(
    event: Record<string, unknown>,
    completedState?: SerializedResponsesFrame['completedState'],
  ): string {
    const type = typeof event.type === 'string' ? event.type : 'message';
    const sequencedEvent = {
      ...event,
      sequence_number: this.sequenceNumber,
    };
    this.sequenceNumber += 1;
    const json = JSON.stringify(sequencedEvent);
    const sse = `event: ${type}\ndata: ${json}\n\n`;
    this.options.onSerializedFrame?.({ sse, json, completedState });
    return sse;
  }
}
