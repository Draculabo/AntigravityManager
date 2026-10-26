# Agent Note: Readable-backed SSE producers participate in output backpressure

Status: implemented

## Problem

The previous pending-byte guard bounded sockets but rejected a valid single 32 MiB event.
Protocol Observables exposed no way for the writer to pause their actual upstream Readables.
Slow readers also required an aggregate retained-output policy across concurrent responses.

## Decision

Carry explicit flow capability on a narrow Observable subtype owned by the gateway transport.
The existing external Observable contract stays compatible. Real Gemini, OpenAI Chat,
Responses and Anthropic adapters name their Readable owner; the Anthropic preflight wrapper
preserves this capability and respects a pause during buffered-event handoff.

A common output pump pauses that owner when the socket reports pressure and resumes after
drain. It slices strings on Unicode boundaries and copies slices into small socket Buffers.
It holds completion/error output until earlier frames drain, keeping wire order intact.
Estimated retained strings use 128 MiB per-stream and 256 MiB process-wide budgets. A frame
keeps its complete reservation until its last blocked write drains. A 30-second drain timeout,
budget overflow or write failure terminates only that response with partial diagnostics and
no automatic retry. Close removes listeners and releases all reservations.

Plain Observable producers retain the previous bounded failure policy. Synthetic responses
and arbitrary RxJS wrappers do not gain flow capability by assumption. No new dependency,
public configuration format, credential behavior or durable schema is introduced.

## Alternatives considered

- Increase the socket cap alone: still allows continued upstream production for a slow reader.
- Use an unbounded drain queue: transfers the problem into JavaScript retention.
- Treat all Observables as pausable: synthetic producers have no Readable to control.
- Rewrite all adapters as async generators: unnecessary protocol churn for the existing
  Readable-backed path; later producer rewrites can preserve this narrow transport seam.
- Claim the global pump budget caps RSS: excludes parsing, mapping, audit and caller allocations.

## Consequences

Large individual events require full upstream decode/mapping before the transport can slice
them; the pump cannot preempt the current callback. Its UTF-16 estimate can reject unusually
large output even if wire bytes are smaller. Flow-capable streams are single-consumer owners;
wrapping them in an operator that returns a plain Observable loses that capability. Other
transports, including Responses WebSocket, need their own flow integration. The generic
16 MiB guard remains for producers that cannot cooperate.

## Verification

A production Gemini-path test first fails because its source remains flowing after a blocked
write. Tests then verify pause/drain/resume for Gemini, Chat, Responses and Anthropic preflight.
Pump tests verify large Unicode segmentation, final-drain completion, aggregate-budget isolation
and timeout cleanup. Existing controller, retry and stream lifecycle tests retain compatibility.

Native loopback HTTP acceptance pauses three readers of the same synthetic 32 MiB Unicode
event. Each producer stops after its first event, all readers later receive identical complete
hashes, and a fourth budget-exceeding stream does not discard the accepted streams. Disconnect
releases its source and reservations. A differential harness hides only flow capability and
reproduces the old large-event failure. Memory samples are observations, not a whole-process
bound or a live-provider/packaged Electron claim.

Current behavior is documented in [diagnostic retention](../../../../docs/modules/proxy-gateway/diagnostic-retention.md).
