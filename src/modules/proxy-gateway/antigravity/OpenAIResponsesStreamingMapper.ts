import { SignatureStore } from './SignatureStore';
import { decodeSignature } from './signature-utils';
import { optimizeApplyPatch, validateApplyPatchV4A } from './ApplyPatchPreflight';
import { extractCustomToolInput, isCustomToolCall } from './CustomToolCall';
import { resolveShellToolName } from './ShellToolName';
import { splitNamespaceToolName } from './ToolNamespace';
import type { OpenAIResponsesUsage } from './OpenAIUsageMapper';

export interface GeminiResponsesStreamPart {
  functionCall?: {
    args: Record<string, unknown>;
    id?: string;
    name: string;
  };
  inlineData?: {
    data: string;
    mimeType: string;
  };
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
}

export interface GeminiResponsesGroundingMetadata {
  groundingChunks?: Array<{
    web?: {
      title?: string;
      uri?: string;
    };
  }>;
  webSearchQueries?: string[];
}

interface ResponsesMessageOutputItem {
  content: Array<{
    text: string;
    type: 'output_text';
  }>;
  id: string;
  phase: 'commentary' | 'final_answer';
  role: 'assistant';
  status: 'completed';
  type: 'message';
}

interface ResponsesFunctionCallOutputItem {
  arguments: string;
  call_id: string;
  id: string;
  name: string;
  namespace?: string;
  status: 'completed';
  type: 'function_call';
}

interface ResponsesCustomToolCallOutputItem {
  call_id: string;
  id: string;
  input: string;
  name: string;
  namespace?: string;
  status: 'completed';
  type: 'custom_tool_call';
}

type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesFunctionCallOutputItem
  | ResponsesCustomToolCallOutputItem;

interface ActiveMessageOutput {
  item: ResponsesMessageOutputItem;
  itemId: string;
  outputIndex: number;
  text: string;
}

interface OpenAIResponsesStreamingMapperOptions {
  clientToolNames?: ReadonlySet<string>;
  model: string;
  responseId: string;
  signatureMessageCount?: number;
  signatureSessionKey?: string;
}

export class OpenAIResponsesStreamingMapper {
  private readonly emittedToolCallIds = new Set<string>();
  private readonly outputItems: ResponsesOutputItem[] = [];
  private activeMessage: ActiveMessageOutput | null = null;
  private activeThought: ActiveMessageOutput | null = null;
  private completed = false;
  private hasSeenRegularText = false;
  private hasToolCall = false;
  private messageCounter = 0;
  private nextOutputIndex = 0;
  private sequenceNumber = 0;
  private usage: OpenAIResponsesUsage | undefined;

  constructor(private readonly options: OpenAIResponsesStreamingMapperOptions) {}

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

  public processPart(part: GeminiResponsesStreamPart): string[] {
    if (this.completed) {
      return [];
    }

    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
    if (part.functionCall) {
      return this.processFunctionCall(part.functionCall, signature);
    }

    if (signature) {
      SignatureStore.store(
        signature,
        this.options.signatureSessionKey,
        this.options.signatureMessageCount,
      );
    }

    if (part.thought && part.text) {
      return this.processThought(part.text);
    }

    if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      return this.processText(
        `\n\n![Generated Image](data:${mimeType};base64,${part.inlineData.data})\n\n`,
      );
    }

    if (part.text) {
      return this.processText(part.text);
    }

    return [];
  }

  public processGrounding(grounding: GeminiResponsesGroundingMetadata): string[] {
    let groundingText = '';
    if (grounding.webSearchQueries && grounding.webSearchQueries.length > 0) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${grounding.webSearchQueries.join(', ')}`;
    }

    if (grounding.groundingChunks) {
      const links = grounding.groundingChunks.flatMap((chunk, index) => {
        if (!chunk.web) {
          return [];
        }
        const title = chunk.web.title || 'Web source';
        const uri = chunk.web.uri || '#';
        return [`[${index + 1}] [${title}](${uri})`];
      });
      if (links.length > 0) {
        groundingText += `\n\n**🌐 Citations:**\n${links.join('\n')}`;
      }
    }

    return groundingText ? this.processText(groundingText) : [];
  }

  public setUsage(usage: OpenAIResponsesUsage): void {
    this.usage = usage;
  }

  public complete(): string[] {
    if (this.completed) {
      return [];
    }

    this.completed = true;
    const events = [
      ...this.closeThought(),
      ...this.closeMessage(this.hasToolCall ? 'commentary' : 'final_answer'),
    ];

    events.push(
      this.serialize({
        response: {
          id: this.options.responseId,
          model: this.options.model,
          object: 'response',
          output: this.outputItems,
          status: 'completed',
          usage: this.usage,
        },
        type: 'response.completed',
      }),
    );
    return events;
  }

  private startMessage(kind: 'message' | 'thought'): string[] {
    const existing = kind === 'thought' ? this.activeThought : this.activeMessage;
    if (existing) {
      return [];
    }

    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId =
      kind === 'thought'
        ? `msg_thought_${this.options.responseId}_${this.messageCounter}`
        : `msg_${this.options.responseId}_${this.messageCounter}`;
    this.messageCounter += 1;
    const item: ResponsesMessageOutputItem = {
      content: [{ text: '', type: 'output_text' }],
      id: itemId,
      phase: 'commentary',
      role: 'assistant',
      status: 'completed',
      type: 'message',
    };
    const activeOutput = {
      item,
      itemId,
      outputIndex,
      text: '',
    };
    if (kind === 'thought') {
      this.activeThought = activeOutput;
    } else {
      this.activeMessage = activeOutput;
    }
    this.outputItems.push(item);

    return [
      this.serialize({
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
      }),
      this.serialize({
        content_index: 0,
        item_id: itemId,
        output_index: outputIndex,
        part: {
          text: '',
          type: 'output_text',
        },
        type: 'response.content_part.added',
      }),
    ];
  }

  private closeThought(): string[] {
    const thought = this.activeThought;
    if (!thought) {
      return [];
    }
    this.activeThought = null;
    return this.finishMessage(thought, 'commentary');
  }

  private closeMessage(phase: 'commentary' | 'final_answer'): string[] {
    const message = this.activeMessage;
    if (!message) {
      return [];
    }
    this.activeMessage = null;
    return this.finishMessage(message, phase);
  }

  private finishMessage(
    message: ActiveMessageOutput,
    phase: 'commentary' | 'final_answer',
  ): string[] {
    message.item.content = [{ text: message.text, type: 'output_text' }];
    message.item.phase = phase;
    return [
      this.serialize({
        content_index: 0,
        item_id: message.itemId,
        output_index: message.outputIndex,
        text: message.text,
        type: 'response.output_text.done',
      }),
      this.serialize({
        content_index: 0,
        item_id: message.itemId,
        output_index: message.outputIndex,
        part: {
          text: message.text,
          type: 'output_text',
        },
        type: 'response.content_part.done',
      }),
      this.serialize({
        item: message.item,
        output_index: message.outputIndex,
        type: 'response.output_item.done',
      }),
    ];
  }

  private processFunctionCall(
    functionCall: NonNullable<GeminiResponsesStreamPart['functionCall']>,
    signature: string | undefined,
  ): string[] {
    const splitName = splitNamespaceToolName(functionCall.name);
    const functionName = this.options.clientToolNames
      ? resolveShellToolName(splitName.name, this.options.clientToolNames)
      : splitName.name;
    const callId = functionCall.id || `call_${this.options.responseId}_${this.nextOutputIndex}`;
    if (signature) {
      SignatureStore.store(
        signature,
        this.options.signatureSessionKey,
        this.options.signatureMessageCount,
        callId,
      );
    }
    if (functionCall.id && this.emittedToolCallIds.has(callId)) {
      return [];
    }
    if (functionCall.id) {
      this.emittedToolCallIds.add(callId);
    }

    const normalizedArguments = this.normalizeShellArguments(functionName, functionCall.args);
    const isCustomTool = isCustomToolCall(functionName) || functionName === 'shell';
    const argumentsString = JSON.stringify(normalizedArguments);
    let input = isCustomTool
      ? isCustomToolCall(functionName)
        ? extractCustomToolInput(functionName, normalizedArguments)
        : argumentsString
      : undefined;
    if (isCustomToolCall(functionName) && input !== undefined) {
      const optimizedPatch = optimizeApplyPatch(input);
      const validationError = validateApplyPatchV4A(optimizedPatch.input);
      if (validationError) {
        return this.processText(
          `[apply_patch rejected: invalid V4A syntax at line ${validationError.line}: ${validationError.message}]`,
        );
      }
      input = optimizedPatch.input;
    }

    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId = `item_${this.options.responseId}_${outputIndex}`;

    const inProgressItem = isCustomTool
      ? {
          call_id: callId,
          id: itemId,
          input: '',
          name: functionName,
          ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
          status: 'in_progress' as const,
          type: 'custom_tool_call' as const,
        }
      : {
          arguments: '',
          call_id: callId,
          id: itemId,
          name: functionName,
          ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
          status: 'in_progress' as const,
          type: 'function_call' as const,
        };
    const completedItem: ResponsesFunctionCallOutputItem | ResponsesCustomToolCallOutputItem =
      isCustomTool
        ? {
            call_id: callId,
            id: itemId,
            input: input ?? '',
            name: functionName,
            ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
            status: 'completed',
            type: 'custom_tool_call',
          }
        : {
            arguments: argumentsString,
            call_id: callId,
            id: itemId,
            name: functionName,
            ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
            status: 'completed',
            type: 'function_call',
          };
    this.outputItems.push(completedItem);

    this.hasToolCall = true;
    const events = [
      ...this.closeThought(),
      ...this.closeMessage('commentary'),
      this.serialize({
        item: inProgressItem,
        output_index: outputIndex,
        type: 'response.output_item.added',
      }),
    ];

    if (isCustomTool) {
      events.push(
        this.serialize({
          call_id: callId,
          delta: input ?? '',
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.custom_tool_call_input.delta',
        }),
        this.serialize({
          call_id: callId,
          input: input ?? '',
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.custom_tool_call_input.done',
        }),
      );
    } else {
      events.push(
        this.serialize({
          delta: argumentsString,
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.function_call_arguments.delta',
        }),
        this.serialize({
          arguments: argumentsString,
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.function_call_arguments.done',
        }),
      );
    }

    events.push(
      this.serialize({
        item: completedItem,
        output_index: outputIndex,
        type: 'response.output_item.done',
      }),
    );

    return events;
  }

  private processText(text: string): string[] {
    const events = [...this.closeThought(), ...this.startMessage('message')];
    const message = this.activeMessage;
    if (!message) {
      throw new Error('Responses text item failed to start');
    }
    this.hasSeenRegularText = true;
    message.text += text;
    events.push(
      this.serialize({
        content_index: 0,
        delta: text,
        item_id: message.itemId,
        output_index: message.outputIndex,
        type: 'response.output_text.delta',
      }),
    );
    return events;
  }

  private processThought(text: string): string[] {
    const cleanText = text
      .replaceAll('<think>\n', '')
      .replaceAll('<think>', '')
      .replaceAll('\n</think>', '')
      .replaceAll('</think>', '');
    if (!cleanText) {
      return [];
    }
    if (this.hasSeenRegularText) {
      return [];
    }

    const events = this.startMessage('thought');
    const thought = this.activeThought;
    if (!thought) {
      throw new Error('Responses thought item failed to start');
    }
    thought.text += cleanText;
    events.push(
      this.serialize({
        content_index: 0,
        delta: cleanText,
        item_id: thought.itemId,
        output_index: thought.outputIndex,
        type: 'response.output_text.delta',
      }),
    );
    return events;
  }

  private normalizeShellArguments(
    functionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!['shell', 'bash', 'local_shell'].includes(functionName) || 'command' in args) {
      return args;
    }

    for (const alternativeKey of ['cmd', 'code', 'script', 'shell_command']) {
      if (alternativeKey in args) {
        const { [alternativeKey]: command, ...remainingArgs } = args;
        return {
          ...remainingArgs,
          command,
        };
      }
    }
    return args;
  }

  private serialize(event: Record<string, unknown>): string {
    const type = typeof event.type === 'string' ? event.type : 'message';
    const sequencedEvent = {
      ...event,
      sequence_number: this.sequenceNumber,
    };
    this.sequenceNumber += 1;
    return `event: ${type}\ndata: ${JSON.stringify(sequencedEvent)}\n\n`;
  }
}
