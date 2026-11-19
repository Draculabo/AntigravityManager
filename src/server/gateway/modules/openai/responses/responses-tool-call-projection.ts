import {
  isDeclaredOpenAICustomTool,
  readCustomToolInput,
} from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { splitNamespaceToolName } from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import type { GenerationStreamToolCall } from '@/modules/proxy-gateway/antigravity/AntigravityStreamDecoder';
import type { OpenAITool } from '../../../common/interfaces/request-interfaces';

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

export type ResponsesToolCallOutputItem =
  | ResponsesFunctionCallOutputItem
  | ResponsesCustomToolCallOutputItem;

export function createResponsesToolCallProjection(
  functionCall: GenerationStreamToolCall,
  callId: string,
  itemId: string,
  outputIndex: number,
  clientTools?: OpenAITool[],
) {
  const splitName = splitNamespaceToolName(functionCall.name, clientTools);
  const functionName = splitName.name;
  const normalizedArguments = functionCall.arguments;
  const isCustomTool = isDeclaredOpenAICustomTool(functionCall.name, clientTools);
  const argumentsString = JSON.stringify(normalizedArguments);
  const input = isCustomTool ? readCustomToolInput(normalizedArguments) : '';
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
  const completedItem: ResponsesToolCallOutputItem = isCustomTool
    ? {
        call_id: callId,
        id: itemId,
        input,
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

  function* events() {
    yield {
      item: inProgressItem,
      output_index: outputIndex,
      type: 'response.output_item.added',
    };
    if (isCustomTool) {
      yield {
        call_id: callId,
        delta: input,
        item_id: itemId,
        output_index: outputIndex,
        type: 'response.custom_tool_call_input.delta',
      };
      yield {
        call_id: callId,
        input,
        item_id: itemId,
        output_index: outputIndex,
        type: 'response.custom_tool_call_input.done',
      };
    } else {
      yield {
        delta: argumentsString,
        item_id: itemId,
        output_index: outputIndex,
        type: 'response.function_call_arguments.delta',
      };
      yield {
        arguments: argumentsString,
        item_id: itemId,
        output_index: outputIndex,
        type: 'response.function_call_arguments.done',
      };
    }
    yield {
      item: completedItem,
      output_index: outputIndex,
      type: 'response.output_item.done',
    };
  }
  return { completedItem, events };
}
