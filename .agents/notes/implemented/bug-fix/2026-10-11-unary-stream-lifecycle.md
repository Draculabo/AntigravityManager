# Agent Note: Unary collection and closed WebSocket history ownership

Status: implemented

## Problem

The unary Gemini stream fallback repeatedly split the complete unfinished line after each
fragment. A native 32 MiB fixture scanned about 8.6 billion characters through that path.
Its anonymous data/end/error listeners remained on completed upstream objects and retained
the merged response. Closed Responses WebSocket contexts likewise retained request, completed
output and tool repair history while late operations or diagnostic owners referenced them.

## Decision

Move the shared collector into an owned common module and reuse the existing incremental
line reader. Give collection one terminal cleanup path. Transfer the completed part array
to the caller on success; discard partial parts and fragments on failure, remove only owned
listeners and clear the idle timer. Premature close and already destroyed streams fail
explicitly instead of waiting for an idle deadline. Apply the existing unfinished-line
budget to this collector, without introducing a total response limit or silent truncation.
Append accepted parts individually rather than spreading a provider-sized array into a call;
engine argument limits must not silently drop that array.

Dispose the Responses WebSocket protocol context on transport failure and socket close.
Clear request/output/history and tool caches before late operations can retain a closed
connection's full transcript. Leave active connection continuation and repair semantics intact.

The [current reference](../../../../docs/modules/proxy-gateway/diagnostic-retention.md#unary-stream-aggregation)
owns numerical limits and recovery behavior.

## Alternatives considered

Relying on garbage collection assumes the upstream or connection becomes unreachable when
the operation ends. Explicit cleanup releases domain state independently of that assumption.
Removing all stream listeners could break another owner; remove only the collector's handlers.

A total collection or active-history budget needs an explicit admission/error policy and
would change accepted requests. This change measures those lifetimes without inventing that
policy. Combining or deleting accepted text/tool parts would alter part boundaries and
protocol meaning; preserve the collected order and metadata.

## Consequences

Fragmented-line work becomes linear and completed streams no longer retain collector-owned
response arrays. Closing connections releases their history even when the context remains
referenced. Open connections, callers' unary responses, source-owned chunk buffers, simultaneous
JSON decoding and protocol-required full-text fields can still consume substantial memory.
There is no aggregate RSS ceiling or guarantee of immediate OS memory reclamation.

Pending output consumption and indexed active tool repair follow the
[active-history decision](2026-10-11-active-responses-history.md). Its concurrent collector
measurements confirm the remaining shared aggregation admission gap.

Malformed-line/nested-field recovery and trailing unterminated-line handling remain legacy
fallback behavior. Changing that error policy is separate scope. Durable formats, credentials,
authentication and provider retry behavior are unchanged.

## Verification

Regression tests fail before this change on repeated fragment scans, retained upstream
listeners and retained closed-context history. Focused checks cover complete output, Unicode
fragmentation, malformed recovery, caller-owned listeners, empty input, errors, close,
already destroyed streams, idle cleanup and large part arrays. Existing real-path Chat,
Responses, Anthropic and Gemini parity and continuation suites cover the shared fallback.

Native synthetic fixtures measure 32 MiB fragmented collection, four retained completed
upstreams and four closed WebSocket contexts before and after the change. A separate concurrent
loopback case confirms four simultaneous connections and complete output hashes. Native
failure fixtures cover the actual line budget, premature close, error and idle cleanup.
WebSocket memory measurements include a same-process client and deliberately retained closed
contexts; they do not establish provider, installed Electron or global process-memory behavior.
