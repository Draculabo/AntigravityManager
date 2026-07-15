import { SignatureStore } from './SignatureStore';
import { decodeSignature } from './signature-utils';

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
  role: 'assistant';
  status: 'completed';
  type: 'message';
}

interface ResponsesFunctionCallOutputItem {
  arguments: string;
  call_id: string;
  id: string;
  name: string;
  status: 'completed';
  type: 'function_call';
}

type ResponsesOutputItem = ResponsesMessageOutputItem | ResponsesFunctionCallOutputItem;

interface OpenAIResponsesStreamingMapperOptions {
  model: string;
  responseId: string;
}

export class OpenAIResponsesStreamingMapper {
  private readonly emittedToolCallIds = new Set<string>();
  private readonly messageItemId: string;
  private readonly outputItems: ResponsesOutputItem[] = [];
  private accumulatedText = '';
  private completed = false;
  private messageOutputItem: ResponsesMessageOutputItem | null = null;
  private nextOutputIndex = 0;
  private textOutputIndex: number | null = null;

  constructor(private readonly options: OpenAIResponsesStreamingMapperOptions) {
    this.messageItemId = `msg_${options.responseId}`;
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

  public processPart(part: GeminiResponsesStreamPart): string[] {
    if (this.completed) {
      return [];
    }

    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
    if (signature) {
      SignatureStore.store(signature);
    }

    if (part.functionCall) {
      return this.processFunctionCall(part.functionCall);
    }

    if (part.thought) {
      return [];
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

  public complete(): string[] {
    if (this.completed) {
      return [];
    }

    this.completed = true;
    const events: string[] = [];
    if (this.textOutputIndex !== null) {
      events.push(
        this.serialize({
          content_index: 0,
          item_id: this.messageItemId,
          output_index: this.textOutputIndex,
          text: this.accumulatedText,
          type: 'response.output_text.done',
        }),
      );
      events.push(
        this.serialize({
          content_index: 0,
          item_id: this.messageItemId,
          output_index: this.textOutputIndex,
          part: {
            text: this.accumulatedText,
            type: 'output_text',
          },
          type: 'response.content_part.done',
        }),
      );

      const messageItem = this.messageOutputItem;
      if (!messageItem) {
        throw new Error('Responses text item is missing its final output record');
      }
      messageItem.content = [{ text: this.accumulatedText, type: 'output_text' }];
      events.push(
        this.serialize({
          item: messageItem,
          output_index: this.textOutputIndex,
          type: 'response.output_item.done',
        }),
      );
    }

    events.push(
      this.serialize({
        response: {
          id: this.options.responseId,
          model: this.options.model,
          object: 'response',
          output: this.outputItems,
          status: 'completed',
        },
        type: 'response.completed',
      }),
    );
    return events;
  }

  private ensureTextStarted(): string[] {
    if (this.textOutputIndex !== null) {
      return [];
    }

    this.textOutputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    this.messageOutputItem = {
      content: [{ text: '', type: 'output_text' }],
      id: this.messageItemId,
      role: 'assistant',
      status: 'completed',
      type: 'message',
    };
    this.outputItems.push(this.messageOutputItem);
    return [
      this.serialize({
        item: {
          content: [],
          id: this.messageItemId,
          role: 'assistant',
          status: 'in_progress',
          type: 'message',
        },
        output_index: this.textOutputIndex,
        type: 'response.output_item.added',
      }),
      this.serialize({
        content_index: 0,
        item_id: this.messageItemId,
        output_index: this.textOutputIndex,
        part: {
          text: '',
          type: 'output_text',
        },
        type: 'response.content_part.added',
      }),
    ];
  }

  private processFunctionCall(
    functionCall: NonNullable<GeminiResponsesStreamPart['functionCall']>,
  ): string[] {
    const callId = functionCall.id || `call_${this.options.responseId}_${this.nextOutputIndex}`;
    if (functionCall.id && this.emittedToolCallIds.has(callId)) {
      return [];
    }
    if (functionCall.id) {
      this.emittedToolCallIds.add(callId);
    }

    const argumentsString = JSON.stringify(
      this.normalizeShellArguments(functionCall.name, functionCall.args),
    );
    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;

    const inProgressItem = {
      arguments: '',
      call_id: callId,
      id: callId,
      name: functionCall.name,
      status: 'in_progress',
      type: 'function_call' as const,
    };
    const completedItem: ResponsesFunctionCallOutputItem = {
      arguments: argumentsString,
      call_id: callId,
      id: callId,
      name: functionCall.name,
      status: 'completed',
      type: 'function_call',
    };
    this.outputItems.push(completedItem);

    return [
      this.serialize({
        item: inProgressItem,
        output_index: outputIndex,
        type: 'response.output_item.added',
      }),
      this.serialize({
        delta: argumentsString,
        item_id: callId,
        output_index: outputIndex,
        type: 'response.function_call_arguments.delta',
      }),
      this.serialize({
        arguments: argumentsString,
        item_id: callId,
        output_index: outputIndex,
        type: 'response.function_call_arguments.done',
      }),
      this.serialize({
        item: completedItem,
        output_index: outputIndex,
        type: 'response.output_item.done',
      }),
    ];
  }

  private processText(text: string): string[] {
    const events = this.ensureTextStarted();
    this.accumulatedText += text;
    events.push(
      this.serialize({
        content_index: 0,
        delta: text,
        item_id: this.messageItemId,
        output_index: this.textOutputIndex,
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
    return `data: ${JSON.stringify(event)}\n\n`;
  }
}
