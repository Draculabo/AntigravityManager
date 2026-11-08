# Agent Note: chronological tool-result association

Status: implemented

## Problem

Claude conversion retained a global ID-to-name map without consuming completed calls.
An uncompleted duplicate ID could overwrite the preceding name, and an orphan result
used its ID as an invented function name. That contradicted confirmed D04 R3.

## Decision

The protocol adapter owns an invocation-local pending-call tracker. Calls register their
ID and name; results consume that pending ID. Duplicate pending calls, missing pending
calls and incorrect message roles fail explicitly with a typed HTTP 400 and position-only
diagnostic. Distinct IDs preserve parallel same-name calls. Completed IDs remain reusable.
The tracker does not execute tools or change public IDs, parameters or signed parts.

Anthropic admission checks before media/schema preparation and account selection.
The mapper repeats the same association policy for direct and count-tokens callers.
OpenAI Chat shares conversion and treats its failure as terminal after account selection.
The common error boundary identifies it as `invalid_request_error`. No account penalty,
protocol fallback or automatic replay repairs invalid history.

Responses preprocessing resolves names in the same chronological pass that emits calls.
It no longer pre-scans later calls to name an earlier round. Incomplete custom-call
exclusion starts at that call's position and ends with its excluded output, rather than
erasing every historical occurrence of the same ID.
Session merging validates pending IDs in chronological order instead of globally removing
reused IDs. A continuation delta is not independently repaired from the parent's tool cache:
repair against the complete parent history avoids duplicating one pending call in the
request and retained lineage. Root and compaction-reset input still repair from their cache.

Responses keeps complete leading exchanges and rejects unmatched function/custom results.
Cached repair is chronological, so a later reused ID cannot suppress recovery of an earlier
call. Conflicting cache candidates are retained as ambiguity rather than overwritten:
socket entries use an invocation-local collision marker and durable arrays keep at most
two distinct witnesses per ID. An exact duplicate candidate is one witness, not a conflict.
Complete retained history takes precedence over cached ambiguity. Identical durable-item
replays keep their first position; different payloads sharing an item ID fail explicitly.
Tool payloads participate in full-replay equality and are not anonymous suffix anchors.

Native Gemini retains the declared function name alongside each pending ID. A response
must name that same function, including when it inherits an ID from one pending call.
The exact placeholder `unknown` can inherit a known nonempty call name only through
an explicitly supplied matching pending ID. The repair consumes the call chronologically
and clones the changed result while preserving the original payload. Missing IDs,
orphan IDs and conflicting explicit names retain the existing failure rules.
A conflicting name returns a position-only `conflicting-result-name` failure before
account selection. Completed IDs can name another function in a later round, and valid
responses retain their complete payload. This extends the existing invocation-local
tracker without changing generated ID hashes, tool execution or auxiliary token counting.

## Alternatives considered

- Choose the last name for an ambiguous ID: rejected because pending calls are indistinguishable.
- Use an orphan result ID as its name: rejected because no preceding call establishes it.
- Rename all duplicate public IDs: rejected because it rewrites client associations.
- Reject all reused IDs: rejected because completed sequential rounds are unambiguous.
- Add a durable tracker: rejected because association is established from request history.

## Consequences

Malformed histories previously accepted now fail. The [upgrade guide](../../../../docs/upgrade-guides/next/retain-tool-call-history.md)
describes client recovery without repeating side effects. Pending tracker memory is bounded
by the admitted history, and consumed IDs are removed. There is no new durable format,
credential handling, dependency, encryption or retry.

This implements Claude-history association, Responses chronological repair and native
Gemini pending-call name binding. Deterministic ID generation already belongs to the
respective protocol normalizers; signature-cache turn identity remains a separate D04
obligation and is not established by pending-call admission alone.

## Verification

The latest selection passes 29 Vitest files / 363 checks, including mapper and real production
service/controller paths with a fake upstream and lease boundary, WebSocket, session storage
and upgrade fixtures. TypeScript and focused ESLint pass.
The slice report (local artifact `D04-tool-result-association-implementation.md` in the 2026-10-11 review collection)
records exact evidence and environment limitations. Live-provider acceptance remains deferred.
The Responses repair follow-up (local artifact `D04-responses-history-repair-implementation.md` in the 2026-10-11 review collection)
records the chronological cache, replay and no-lease rejection evidence.

The 2026-11-05 native-name regression fails for both explicit and inherited result IDs
before this change, with four neighboring tests preserved. The repaired selection also
checks stream/unary no-lease rejection and valid sequential ID reuse with distinct names.
