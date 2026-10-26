import { isPlainObject } from 'lodash-es';
import { z } from 'zod';
import { resolveResponsesInputType } from './responses-input-type';

const MessageItem = z.object({
  type: z.literal('message'),
  role: z.preprocess((role) => (typeof role === 'string' ? role : 'user'), z.string()),
  content: z.unknown().optional(),
});
const FunctionCallItem = z.object({
  type: z.literal('function_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  namespace: z.string().optional(),
  arguments: z.unknown().optional(),
});
const LocalShellCallItem = z.object({
  type: z.literal('local_shell_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  action: z.object({ exec: z.object({ command: z.string().optional() }).optional() }).optional(),
});
const WebSearchCallItem = z.object({
  type: z.literal('web_search_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  action: z.object({ query: z.string().optional() }).optional(),
});
const CustomToolCallItem = z.object({
  type: z.literal('custom_tool_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  namespace: z.string().optional(),
  input: z.string().optional(),
  status: z.string().optional(),
});
const ToolOutputItem = z.object({
  type: z.enum(['function_call_output', 'custom_tool_call_output']),
  call_id: z.string().optional(),
  id: z.string().optional(),
  output: z.unknown().optional(),
});
const InputItem = z.preprocess(
  (value) =>
    isPlainObject(value) && resolveResponsesInputType(value) === 'message'
      ? Object.assign({}, value, { type: 'message' })
      : value,
  z.discriminatedUnion('type', [
    MessageItem,
    FunctionCallItem,
    LocalShellCallItem,
    WebSearchCallItem,
    CustomToolCallItem,
    ToolOutputItem,
  ]),
);

export type ResponsesInputItem = z.infer<typeof InputItem>;
export type ResponsesToolCallItem = Exclude<
  ResponsesInputItem,
  z.infer<typeof MessageItem> | z.infer<typeof ToolOutputItem>
>;

export function parseResponsesInputItem(input: unknown): ResponsesInputItem | null {
  const parsed = InputItem.safeParse(input);
  return parsed.success ? parsed.data : null;
}
