import { isString } from 'lodash-es';
import { z } from 'zod';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import { qualifyNamespaceToolName } from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import { hashSessionAnchor } from '../../../common/session-anchor-hash';
import { parseResponsesInputItem, type ResponsesToolCallItem } from './responses-input-item';
import { getCallId, getStringField } from './responses-tool-call-repair';

const ArgumentsRecord = z.record(z.string(), z.unknown());
const toolActivityTypes = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
  'function_call_output',
  'custom_tool_call_output',
]);

export function resolveResponsesToolName(item: ResponsesToolCallItem): string {
  return item.type === 'local_shell_call'
    ? 'shell'
    : item.type === 'web_search_call'
      ? 'builtin_web_search'
      : qualifyNamespaceToolName(item.namespace ?? '', item.name ?? 'unknown');
}

export function resolveToolArguments(item: ResponsesToolCallItem): Record<string, unknown> {
  if (item.type === 'local_shell_call') {
    const command = item.action?.exec?.command;
    return { command: command ? [command] : [] };
  }
  if (item.type === 'web_search_call') {
    return { query: item.action?.query ?? '' };
  }
  if (item.type === 'custom_tool_call') {
    return { input: item.input ?? '' };
  }
  const raw = item.arguments;
  if (isString(raw)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = ArgumentsRecord.safeParse(parsed);
      return record.success ? record.data : { value: parsed };
    } catch {
      return { raw };
    }
  }
  const record = ArgumentsRecord.safeParse(raw);
  return record.success ? record.data : {};
}

/** Canonicalize once against complete history, then retain exactly its matching delta items. */
export function normalizeResponsesToolCallIds(
  items: unknown[],
  retainedDelta: unknown[] = [],
): { items: unknown[]; delta: unknown[] } {
  if (
    !items.some(
      (item) => toolActivityTypes.has(getStringField(item, 'type') ?? '') && !getCallId(item),
    )
  ) {
    return { items, delta: retainedDelta };
  }
  let anchor = hashSessionAnchor(['responses-tool-history:v1']);
  const pending = new Set<string>();
  const replacements = new Map<unknown, unknown[]>();
  const normalized = items.map((raw, index) => {
    const item = parseResponsesInputItem(raw);
    let result = raw;
    if (item?.type === 'message') {
      anchor = hashSessionAnchor([anchor, 'message', item.role, item.content]);
    } else if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      let callId = item.call_id || item.id;
      if (!callId) {
        if (pending.size !== 1) {
          throw new InvalidToolResultAssociationError(
            `input[${index}]`,
            pending.size > 1 ? 'ambiguous-missing-id' : 'missing-pending-call',
          );
        }
        callId = [...pending][0];
        result = Object.assign({}, raw, { call_id: callId });
      }
      pending.delete(callId);
      anchor = hashSessionAnchor([anchor, 'output', item.type, callId, item.output]);
    } else if (
      item?.type === 'function_call' ||
      item?.type === 'custom_tool_call' ||
      item?.type === 'local_shell_call' ||
      item?.type === 'web_search_call'
    ) {
      const name = resolveResponsesToolName(item);
      const args = resolveToolArguments(item);
      const callId =
        item.call_id ||
        item.id ||
        `call_${hashSessionAnchor([anchor, 'call', item.type, name, args]).slice(0, 32)}`;
      if (!item.call_id && !item.id) {
        result = Object.assign({}, raw, { call_id: callId });
      }
      pending.add(callId);
      anchor = hashSessionAnchor([anchor, 'call', item.type, name, args, callId]);
    }
    if (retainedDelta.length > 0) {
      const occurrences = replacements.get(raw) ?? [];
      occurrences.push(result);
      replacements.set(raw, occurrences);
    }
    return result;
  });
  const delta: unknown[] = [];
  for (let index = retainedDelta.length - 1; index >= 0; index -= 1) {
    const occurrences = replacements.get(retainedDelta[index]);
    if (occurrences?.length) {
      delta.push(occurrences.pop());
    }
  }
  return { items: normalized, delta: delta.reverse() };
}
