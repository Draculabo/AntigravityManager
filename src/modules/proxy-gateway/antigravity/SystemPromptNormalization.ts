import { stripClaudeBillingMetadata } from './ClientBillingMetadata';
import { overlapsPromptProtection, promptProtectedRegions } from './PromptProtectedRegions';

const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const NEUTRAL_IDENTITY = 'You are an AI Agent';
const MAX_HEAD_CHARACTERS = 8192;

/** Only system-owned input enters this function; ordinary history and signatures never do. */
export function normalizeSystemPrompt(
  text: string,
  onChange?: (kind: 'billing-metadata-removed' | 'identity-normalized') => void,
): string {
  const cleaned = stripClaudeBillingMetadata(text);
  if (cleaned !== text) {
    onChange?.('billing-metadata-removed');
  }
  if (cleaned === SDK_IDENTITY) {
    onChange?.('identity-normalized');
    return CODE_IDENTITY;
  }
  let headEnd = Math.min(cleaned.length, MAX_HEAD_CHARACTERS);
  let sentences = 0;
  for (let index = 0; index < headEnd; index++) {
    const character = cleaned[index];
    const decimal =
      character === '.' &&
      /\d/u.test(cleaned[index - 1] ?? '') &&
      /\d/u.test(cleaned[index + 1] ?? '');
    if (
      (!decimal && /[.!?。！？]/u.test(character)) ||
      (character === '\n' && /\n\r?$/u.test(cleaned.slice(Math.max(0, index - 2), index)))
    ) {
      sentences++;
      if (sentences === 4) {
        headEnd = index + 1;
        break;
      }
    }
  }
  const head = cleaned.slice(0, headEnd);
  const protectedRegions = promptProtectedRegions(cleaned);
  const declaration =
    /(?:^|(?<=[.!?。！？\n]))([\t ]*)(?:you[\t ]+are|you're|i[\t ]+am|i'm)[\t ]+(?:an?[\t ]+)?(?:[\w'’-]+[\t ,，]+){0,8}(?:agent|assistant|ai)\b[^.!?。！？\r\n<>]{0,8}?(?:(?:created|built|made|developed|designed|trained|powered|maintained|published|released|provided)[\t ]+(?:by|on|upon|at)|based[\t ]+on)[\t ]+(?:[^.,，。!?！？\r\n<>]|(?<=\d)\.(?=\d)){1,80}([.,，。!?！？]|(?=$|[\r\n]))/gimu;
  return (
    head.replace(
      declaration,
      (match: string, indentation: string, punctuation: string, offset: number) => {
        const start = offset + indentation.length;
        if (overlapsPromptProtection(protectedRegions, start, offset + match.length)) {
          return match;
        }
        if (offset + match.length === headEnd && headEnd < cleaned.length && !punctuation) {
          return match;
        }
        const trailingWhitespace = /[\t ]+$/u.exec(match)?.[0] ?? '';
        onChange?.('identity-normalized');
        return (
          indentation +
          NEUTRAL_IDENTITY +
          (punctuation === ',' || punctuation === '，' ? punctuation : '.') +
          trailingWhitespace
        );
      },
    ) + cleaned.slice(headEnd)
  );
}
