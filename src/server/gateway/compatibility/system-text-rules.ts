import type { PromptTransformationKind } from '../common/prompt-transformation-diagnostics';
import { stripClaudeBillingMetadata } from './client-billing-metadata';
import {
  overlapsPromptProtection,
  promptProtectedRegions,
  type PromptRange,
} from './prompt-protected-regions';

type SystemTextChange = Extract<
  PromptTransformationKind,
  'billing-metadata-removed' | 'client-security-policy-removed' | 'identity-normalized'
>;
type ReportChange = ((kind: SystemTextChange) => void) | undefined;
type SystemTextRule = (text: string, report: ReportChange) => string;

const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const SDK_CLI_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const NEUTRAL_IDENTITY = 'You are an AI Agent';
const MAX_HEAD_CHARACTERS = 8192;
const OPENCODE_SYSTEM_OPENING =
  /^You are OpenCode, an interactive CLI (?:agent specializing in|tool that helps users with) software engineering tasks\.(?=[\t \r\n]|$)/iu;
const CODEX_SYSTEM_OPENING =
  /^You are a coding agent running in the Codex CLI, a terminal-based coding assistant\.(?= Codex CLI is an open source project led by OpenAI\. You are expected to be precise, safe, and helpful\.(?:\r?\n|$))/u;
const CLIENT_SECURITY_POLICY = new RegExp(
  [
    '^ {0,3}IMPORTANT: Assist with (?:authorized )?security testing, defensive security, CTF challenges, and educational contexts\\.',
    'Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes\\.',
    'Dual-use security tools \\(C2 frameworks, credential testing, exploit development\\) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases(?:[\\t ]*\\.)?[\\t ]*(?:\\r?\\n|$)',
  ].join('[\\t \\r\\n]+'),
  'gimu',
);

function removeBillingMetadata(text: string, onChange: ReportChange): string {
  const withoutBilling = stripClaudeBillingMetadata(text);
  if (withoutBilling !== text) {
    onChange?.('billing-metadata-removed');
  }
  return withoutBilling;
}

function removeKnownClientPolicy(text: string, onChange: ReportChange): string {
  // Match the complete client template. A generic opening or a later Harness heading
  // cannot establish ownership of the instructions between them.
  let policyProtection: PromptRange[] | undefined;
  const cleaned = text.replace(CLIENT_SECURITY_POLICY, (block: string, offset: number) =>
    overlapsPromptProtection(
      (policyProtection ??= promptProtectedRegions(text)),
      offset,
      offset + block.length,
    )
      ? block
      : '',
  );
  if (cleaned !== text) {
    onChange?.('client-security-policy-removed');
    if (cleaned.trim() === '') {
      return '';
    }
  }
  return cleaned;
}

function normalizeClaudeIdentity(text: string, onChange: ReportChange): string {
  if (text === SDK_IDENTITY || text === SDK_CLI_IDENTITY || text === CODE_IDENTITY) {
    onChange?.('identity-normalized');
    return 'You are a coding assistant.';
  }
  return text;
}

function normalizeIdentityHead(cleaned: string, onChange: ReportChange): string {
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
    /(?:^|(?<=[.!?。！？\n]))([\t ]*)(?:you[\t ]+are|you're|i[\t ]+am|i'm)[\t ]+(?:an?[\t ]+)?(?:[\w'’-]+[\t ,，]+){0,8}(?:agent|assistant|ai)\b[^.!?。！？;；\r\n<>]{0,8}?(?:(?:created|built|made|developed|designed|trained|powered|maintained|published|released|provided)[\t ]+(?:by|on|upon|at)|based[\t ]+on)[\t ]+(?:[^.,，。!?！？;；\r\n<>]|(?<=\d)\.(?=\d)){1,80}([.,，。!?！？;；]|(?=$|[\r\n]))/gimu;
  return (
    head
      .replace(
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
            (/^[,，;；]$/u.test(punctuation) ? punctuation : '.') +
            trailingWhitespace
          );
        },
      )
      .replace(OPENCODE_SYSTEM_OPENING, () => {
        onChange?.('identity-normalized');
        return `${NEUTRAL_IDENTITY}.`;
      }) + cleaned.slice(headEnd)
  );
}

function normalizeCodexIdentity(text: string, onChange: ReportChange): string {
  // The complete first line identifies the default client template without matching custom roles.
  return text.replace(CODEX_SYSTEM_OPENING, () => {
    onChange?.('identity-normalized');
    return 'You are a coding assistant.';
  });
}

const systemTextRules: readonly SystemTextRule[] = [
  removeBillingMetadata,
  removeKnownClientPolicy,
  normalizeClaudeIdentity,
  normalizeIdentityHead,
  normalizeCodexIdentity,
];

/** Accepts system text selected by the protocol mapper. */
export function normalizeSystemPrompt(text: string, onChange?: ReportChange): string {
  return systemTextRules.reduce((current, rule) => rule(current, onChange), text);
}
