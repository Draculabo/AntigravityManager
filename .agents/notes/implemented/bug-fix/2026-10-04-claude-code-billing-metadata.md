# Agent Note: Remove injected Claude Code billing metadata from system instructions

Status: implemented

## Problem

Claude Code 2.1.288 repeatedly receives upstream 429 responses while Codex and OpenCode use the
same accounts and physical model successfully. Reducing the output limit and replacing the system
prompt does not resolve it: Claude Code still injects a separate billing metadata block.
The upstream's generic quota message therefore does not establish account exhaustion.

## Decision

Strip complete `x-anthropic-billing-header:` lines at the existing system-instruction
normalization boundary before the Gemini request is built. Protect fenced and inline code. Retain
business instructions, user messages, tool definitions, tool results, thinking configuration,
signatures and account selection. Use the existing mapper path shared by desktop and standalone
runtimes; no client-specific gateway owner behavior is added.

The metadata prefix defines the transport field; `cc_version` is not required. Desktop
clients may supply only `cc_entrypoint` or other billing attributes. Requiring the version
would retain those injected lines and make cleanup dependent on the client release.

## Alternatives considered

- Add accounts or increase retries: an unchanged rejected request also fails on another account.
- Disable thinking or remove tools: this changes the acceptance task and loses requested behavior.
- Expand prompt sanitization to rewrite identity and user text: those changes are unnecessary
  for the observed metadata regression and would broaden its effect on caller instructions.

## Consequences

The filter targets complete metadata lines in system text only. Mid-paragraph references,
user/tool text and quoted code are preserved. Native Gemini system instructions now use
the same helper; delimiter-width, XML example and original-offset protection are owned
by the [shared prompt-boundary decision](../architecture/2026-10-19-prompt-identity-boundaries.md).
A genuine provider quota error is
still returned through the existing retry and error policy.

## Verification

Two real-provider paired replays preserve the same tools and thinking parameters. A/B yields
429 for the original request and 200 with a tool call after removing one billing line. B/A
repeats 200 for the filtered request followed by 429 for the original, reducing the test-order
explanation. Sanitized records are `claude-billing-ab.json` and `claude-billing-ba.json` in the
private acceptance output. These replays establish first-turn compatibility, not full-task success.

Focused tests compare the complete emitted inner request with a metadata-free baseline and
cover adjacent instructions, session metadata, code examples, signed tool history and user text.
The version-independent regression also covers entrypoint-only lines, case/whitespace,
quoted examples and user/tool history. The controlled native acceptance for this regression
was conducted separately from the live-provider comparison below.
The stock Claude Code client completes the full HTML task on Windows and Linux with both CLI
and Electron gateway owners. Each of the four tasks records three successful gateway requests;
both desktop owners also pass the Traffic Monitor comparison. Full results and original failures
remain in the local acceptance report (`artifacts/live-proxy-acceptance-2026-10-04/report.md`).
These passes do not establish thinking capture: the repaired runs report zero reasoning tokens
and no new Thought Store record.
