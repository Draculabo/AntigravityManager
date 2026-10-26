# Agent Note: Claude Agent SDK Identity Normalization

Status: implemented

Superseded by: [Shared prompt identity and protected-region boundaries](../architecture/2026-10-19-prompt-identity-boundaries.md)

## Problem

Claude Agent SDK clients can send a stock identity sentence in the top-level system instruction. Forwarding that sentence unchanged makes the mapped request identify itself as the SDK agent instead of Claude Code, while broad text replacement risks mutating user-authored prompts, embedded system history and cache identity unexpectedly.

## Decision

Normalize only the exact stock Claude Agent SDK identity sentence found in the top-level `system` string or a top-level `system` text block. Replace it with the Claude Code identity before the existing cache sanitizer runs.

Do not classify the replacement as an official-provider identity marker. The existing Antigravity fallback identity remains in the mapped instruction, and all other system content follows the established sanitizer and cache rules.

## Alternatives considered

- Replace the sentence wherever it appears. Rejected because mentions in user-authored prose and embedded role-bearing system messages are not client identity declarations.
- Trim before comparison or accept whitespace variants. Rejected because this broadens the protocol rewrite and can alter intentionally formatted content.
- Add the Claude Code sentence to the official identity markers. Rejected because that would suppress the Antigravity fallback and change the existing mapped-provider identity contract.
- Normalize after cache sanitization. Rejected because the cache-facing instruction must be derived from the normalized protocol identity.

## Consequences

Exact SDK-originated top-level identities map consistently to Claude Code. Longer mentions, whitespace-padded variants and embedded system messages remain byte-for-byte unchanged by this rule. The existing Antigravity identity, sanitizer behavior and extra-system-message handling are preserved.

## Verification

- `npm test -- src/tests/unit/claude-request-mapper-cache-compatibility.test.ts`
- `npm run type-check`
- `npm run check:agent-contracts`
