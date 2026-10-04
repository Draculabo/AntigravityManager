# Agent Note: Thinking Block Signature Recovery

Status: implemented

## Problem

Packaged Windows and Linux Electron acceptance configured `claude-sonnet-4-6` through the
Claude Code card. Both clients wrote their TODO artifact but failed the subsequent turn with
HTTP 400. The captured upstream error was `Invalid signature in thinking block`, with backticks
around the field names, nested as JSON text inside Google's error message. The existing narrow
classifier recognized `Invalid thought signature` and explicit signature field paths, but missed
this equivalent provider wording. It therefore did not invoke the existing recovery operation.
After recognition was added, live reruns showed that the Thought Store restored the rejected
history immediately before transmission, defeating the rewrite. Explicit tool-block signatures
also survived the original rewrite.

## Decision

Recognize only the explicit phrase naming an invalid signature in a thinking block, allowing
the provider's field-name quotes. Retain the existing HTTP 400 and upstream-error requirements.
Use the existing one-attempt history rewrite on the same account and physical model before any
client stream event. The recovery rewrite removes echoed tool signatures without changing tool
IDs, names, arguments or results. Its internal generation option skips Thought Store replay only
for that attempt, including a non-stream response's stream fallback. Normal requests retain
replay. Persisted thought records are not deleted. No additional retry or account rotation is
introduced.

## Alternatives considered

- Selecting only the `-thinking` alias would hide a failure in another selectable model.
- Matching every invalid signature could rewrite requests for unrelated authorization failures.
- Replaying after client stream output could duplicate output or tool execution.

## Consequences

An explicitly rejected thinking signature can now reach the existing recovery behavior. Its
existing rewrite converts rejected historical thinking to text and removes unusable signatures;
it does not prove that the original signature remains valid or that reasoning usage is complete.
Other 400 errors and non-400 responses retain their existing behavior.

## Verification

Classifier tests cover the captured nested provider format and unrelated signature failures.
The real-path Anthropic service test verifies two upstream calls on the same account and model,
no account penalty, preserved context, and one recovery prompt. Packaged live reruns and failed
attempts are recorded separately in the coding-tool acceptance evidence. Loopback HTTP tests
verify that ordinary generation restores cached thoughts while streaming and non-streaming
recovery transmit the clean request unchanged. See the
[coding-tool reference](../../../../docs/coding-tool-configuration.md).
