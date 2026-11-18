import { resolveManualCompactionCommand, type CompactionHistoryProof } from './context-compaction';
import type { AnthropicContent, AnthropicMessage } from './interfaces/request-interfaces';
import { hashSessionAnchor } from './session-anchor-hash';

const MAX_TRACKED_HISTORY_MESSAGES = 256;

function blocksOf(message: AnthropicMessage): AnthropicContent[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}

function messageFingerprint(message: AnthropicMessage): string {
  const content = blocksOf(message).map((block) => {
    const semanticBlock = { ...block };
    Reflect.deleteProperty(semanticBlock, 'cache_control');
    return semanticBlock;
  });
  return hashSessionAnchor({ role: message.role, content });
}

export function trackCoworkHistory(messages: AnthropicMessage[]): readonly string[] | undefined {
  if (messages.length > MAX_TRACKED_HISTORY_MESSAGES) {
    return undefined;
  }
  return Object.freeze(messages.map(messageFingerprint));
}

/** Cowork appends its partial-summary instructions to the last retained prefix message. */
export function matchCoworkPrefixSummary(
  messages: AnthropicMessage[],
  original: readonly string[] | undefined,
): CompactionHistoryProof | undefined {
  if (!original || messages.length === 0 || messages.length >= original.length) {
    return undefined;
  }
  const boundary = messages.at(-1);
  if (boundary?.role !== 'user' || typeof boundary.content === 'string') {
    return undefined;
  }
  const prompt = boundary.content.at(-1);
  if (
    prompt?.type !== 'text' ||
    prompt.text.length > 16_384 ||
    !/conversation (?:so far|up to this point|history)|earlier portion/iu.test(
      prompt.text.slice(0, 700),
    ) ||
    !/continuing|continue the conversation/iu.test(prompt.text.slice(0, 1100)) ||
    !['<analysis>', '<summary>', '<example>'].every((tag) => prompt.text.includes(tag))
  ) {
    return undefined;
  }

  const boundaryIndex = messages.length - 1;
  const content = boundary.content.slice(0, -1);
  const last = content.at(-1);
  if (last?.type !== 'text') {
    return undefined;
  }
  const exactBoundary = messageFingerprint({ ...boundary, content });
  // The client may append a line break while attaching the summary prompt block.
  const withoutSeparator = last.text.replace(/\r?\n$/u, '');
  if (
    exactBoundary !== original[boundaryIndex] &&
    (withoutSeparator === last.text ||
      messageFingerprint({
        ...boundary,
        content: [...content.slice(0, -1), { ...last, text: withoutSeparator }],
      }) !== original[boundaryIndex])
  ) {
    return undefined;
  }
  if (
    !messages
      .slice(0, -1)
      .every((message, index) => messageFingerprint(message) === original[index])
  ) {
    return undefined;
  }
  const retained = original.slice(messages.length);
  return { messages: retained.length, fingerprint: hashSessionAnchor(retained) };
}

export function matchesCoworkRetainedHistory(
  messages: AnthropicMessage[],
  start: number,
  proof: CompactionHistoryProof,
): boolean {
  const retained = messages.slice(start, start + proof.messages);
  return (
    retained.length === proof.messages &&
    hashSessionAnchor(retained.map(messageFingerprint)) === proof.fingerprint
  );
}

/** Native command retries may prepend several complete reminder blocks to the command. */
export function hasCoworkCommandAfterReminders(message: AnthropicMessage | undefined): boolean {
  if (
    message?.role !== 'user' ||
    typeof message.content === 'string' ||
    message.content.length < 2
  ) {
    return false;
  }
  const last = message.content.at(-1);
  if (last?.type !== 'text' || resolveManualCompactionCommand(last.text) !== last.text.trim()) {
    return false;
  }
  const open = '<system-reminder>';
  const close = '</system-reminder>';
  return message.content.slice(0, -1).every((block) => {
    if (block.type !== 'text') {
      return false;
    }
    const text = block.text.trim();
    return (
      text.startsWith(open) &&
      text.endsWith(close) &&
      text.indexOf(close, open.length) === text.length - close.length
    );
  });
}
