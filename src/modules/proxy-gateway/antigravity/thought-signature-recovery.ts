import type { ClaudeRequest, ContentBlock, Message } from './types';

export const INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT =
  '\n\n[System Recovery] Your previous output contained an invalid signature. Please regenerate the response without the corrupted signature block.';

const TOOL_LOOP_ASSISTANT_CLOSURE =
  '[System: Tool execution completed. Proceeding to final response.]';
const TOOL_LOOP_USER_PROMPT = 'Please provide the final result based on the tool output above.';
const INTERRUPTED_TOOL_CLOSURE = '[Tool call was interrupted by user.]';

interface ConversationState {
  inToolLoop: boolean;
  interruptedTool: boolean;
  lastAssistantIndex: number | null;
}

function analyzeConversationState(messages: Message[]): ConversationState {
  const lastAssistantIndex = messages.findLastIndex((message) => message.role === 'assistant');
  if (lastAssistantIndex < 0) {
    return { inToolLoop: false, interruptedTool: false, lastAssistantIndex: null };
  }

  const assistant = messages[lastAssistantIndex];
  const hasToolUse =
    Array.isArray(assistant.content) &&
    assistant.content.some((block) => block.type === 'tool_use');
  const lastMessage = messages.at(-1);
  if (!hasToolUse || lastMessage?.role !== 'user') {
    return { inToolLoop: false, interruptedTool: false, lastAssistantIndex };
  }

  const inToolLoop =
    Array.isArray(lastMessage.content) &&
    lastMessage.content.some((block) => block.type === 'tool_result');
  return {
    inToolLoop,
    interruptedTool: !inToolLoop,
    lastAssistantIndex,
  };
}

function rewriteBlock(block: ContentBlock): ContentBlock | null {
  if (block.type === 'thinking') {
    return block.thinking ? { type: 'text', text: block.thinking } : null;
  }
  if (block.type === 'redacted_thinking') {
    return null;
  }
  return block;
}

function appendRecoveryPrompt(messages: Message[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== 'user') {
    return;
  }

  if (typeof lastMessage.content === 'string') {
    if (!lastMessage.content.endsWith(INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT)) {
      lastMessage.content += INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT;
    }
    return;
  }

  const alreadyPresent = lastMessage.content.some(
    (block) => block.type === 'text' && block.text === INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT,
  );
  if (!alreadyPresent) {
    lastMessage.content.push({
      type: 'text',
      text: INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT,
    });
  }
}

function closeBrokenToolLoop(messages: Message[]): void {
  const state = analyzeConversationState(messages);
  if (state.inToolLoop) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: TOOL_LOOP_ASSISTANT_CLOSURE }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_LOOP_USER_PROMPT }],
    });
    return;
  }

  if (state.interruptedTool && state.lastAssistantIndex !== null) {
    messages.splice(state.lastAssistantIndex + 1, 0, {
      role: 'assistant',
      content: [{ type: 'text', text: INTERRUPTED_TOOL_CLOSURE }],
    });
  }
}

export function rewriteInvalidThoughtSignatureRequest(request: ClaudeRequest): ClaudeRequest {
  const recovered = structuredClone(request);
  appendRecoveryPrompt(recovered.messages);

  for (const message of recovered.messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    message.content = message.content
      .map(rewriteBlock)
      .filter((block): block is ContentBlock => block !== null);
  }

  closeBrokenToolLoop(recovered.messages);
  return recovered;
}
