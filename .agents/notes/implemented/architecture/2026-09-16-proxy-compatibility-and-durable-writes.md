# Agent Note: Proxy compatibility and durable writes

Status: implemented

## Problem

Upstream Gemini tool calls use multiple shell-tool spellings and parameter aliases. Treating those forms differently in Chat Completions, Responses, or streaming routes makes a client-visible protocol depend on the selected transport. `MALFORMED_FUNCTION_CALL` was also not a consistent terminal state: some paths could surface an empty result, a tool-call finish reason, or an incomplete Responses response.

Durable account, application-config, OpenCode-config, and generic JSON records had separate temporary-write implementations. They replaced files without consistently forcing the temporary file to storage first, so their power-loss behavior was weaker and their failure cleanup was independently maintained.

## Decision

The proxy owns one narrow shell-tool compatibility normalizer. It recognizes the documented shell and terminal names case-insensitively, preserves the client's declared spelling, and resolves command aliases in a fixed priority order. Existing non-empty or non-string `command` values remain untouched. A missing or blank command becomes a neutral, cross-shell diagnostic that says the call was skipped; it never claims a successful command execution. Recovery logs contain only `compatibility_recovery=true` and no command or description value.

All OpenAI Chat Completions and Responses mappers use that normalizer in unary and streaming paths. `MALFORMED_FUNCTION_CALL` maps to OpenAI `stop`; if no ordinary text exists, each unary or streaming protocol emits one stable neutral recovery message. Responses marks the terminal response completed rather than incomplete.

Shared persistence owns the common durable write sequence: sibling temporary file, write, file sync, close, atomic replacement, then a parent-directory sync on POSIX. The helper removes temporary state while preserving the primary error. It is used by durable JSON records, the account index's synchronous transaction boundary, application configuration, and OpenCode configuration and account files. The account-index transaction decision in [Serialize account-index transactions](2026-09-09-account-index-transactions.md) is updated to use this durability boundary.

## Alternatives considered

- Use success-like fallback text for an omitted command. Rejected because an omitted command must not be represented as a completed tool action.
- Normalize only Responses or only streaming output. Rejected because clients select these transports independently and would observe different tool payloads or terminal states.
- Keep one temporary-write helper per owner. Rejected because file-sync order, cleanup, permissions, and Windows handling would drift again.
- Convert account-index mutations to asynchronous transactions solely to reuse the async helper. Rejected because synchronous mutation callbacks define the existing serialization contract; the shared layer supplies an equivalent synchronous writer instead.
- Synchronize parent directories on Windows. Rejected because the helper's verified Windows contract is file synchronization plus atomic target replacement; directory synchronization remains explicitly POSIX-only.

## Consequences

Tool-call compatibility is intentionally limited to recognized shell and terminal tools; other functions preserve their original arguments. A malformed upstream tool call becomes visible, retryable protocol text rather than a fake success, and it cannot create duplicate final output after a stream is complete.

Persisted state incurs a file synchronization cost on writes. Any failure before replacement leaves the prior target available; a failure after replacement is reported because durable confirmation is uncertain, while cleanup never masks that primary error. OpenCode account files retain mode `0o600`, and the helper neither logs nor serializes credential values beyond the caller-provided file content.

## Verification

- `src/tests/unit/shell-tool-call-compatibility.test.ts`, `gemini-finish-reason.test.ts`, `openai-tool-mapper.test.ts`, `openai-responses-response-mapper.test.ts`, `openai-responses-streaming-mapper.test.ts`, `claude-response-usage.test.ts`, and `proxy-service-responses-stream.test.ts` cover the shared aliases, unary and streaming transports, malformed-function terminal behavior, and Responses completion state.
- `src/tests/unit/atomic-json-file.test.ts` injects filesystem operations to prove write → file sync → close → replace → POSIX directory sync, cleanup for write/sync/replace/directory-sync failures, and the Windows branch. It also performs real target replacement on the primary Windows filesystem.
- `src/tests/unit/account-index-store.test.ts`, `config-manager-alias-migration.test.ts`, `durable-record-store.test.ts`, and `opencode-sync.service.test.ts` cover the shared writer's owning modules, file permissions, and no temporary-file leftovers.
