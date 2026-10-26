# Upgrade guide: Preserve real tool-history signatures

Target version: next

## Affected users

Clients using earlier gateway versions that automatically add
`skip_thought_signature_validator` to unsigned historical tool calls are affected.
This includes native Gemini Flash forwarding and eligible Claude-to-Gemini histories.
Clients already retaining real signatures can upgrade normally.
Histories relying on recovery across different model families or with missing
recorded model provenance are also affected.
Claude histories relying on a preceding assistant message's thinking signature
to sign a later unsigned call are affected when scoped recovery has no match.
Clients using the recognized Google wrapper around a Claude signature now receive
the raw Claude form from Anthropic response mapping. Both forms remain equivalent
for matching; clients must retain the returned value as opaque.
Native Gemini clients sending conflicting `thoughtSignature` and `thought_signature`
values on the same part now receive HTTP 400 before account selection or upstream dispatch.
Known Claude/Gemini signatures that conflict with the routed model family, Claude-target
placeholders, and recognized signatures on an unregistered target fail before account
selection or history preparation. Gemini targets retain the provider's explicit placeholder
behavior; unknown opaque formats remain unchanged.
Product generation receiving conflicting aliases from Google fails explicitly with a safe
502 or the protocol's stream-failure event. It does not select a replacement signature or
start another generation to hide the conflict.

## Required action

1. Preserve actual provider signatures alongside the matching reasoning and tool calls.
   Keep tool IDs and results associated with their original calls.
2. After upgrading, replay history containing its actual signatures. Missing signatures
   first use existing scoped recovery; an unresolved miss remains unsigned.
3. If the provider rejects that history, supply the original complete signed history or
   begin a fresh conversation from the current task state. Check previous tool results
   before repeating any action that could have side effects.

No profile conversion or application stop is required specifically for this change.
Do not add a placeholder manually as a replacement for a lost provider signature.
For a conflicting-alias error, send one actual signature or equal/recognized equivalent
values in both aliases. The error identifies the content and part position without
including the signature. Rejection adds no account penalty, history write or retry.
For an upstream conflict, retain the error and content/part position for diagnosis. Do not
automatically repeat tools that may already have run. Earlier valid streamed events may
already have been delivered; a failed response is not a completed tool round.
Missing-signature histories that relied on newest-record selection, repeated tool IDs,
visible-text prefixes or a category-only fallback can now remain unsigned. Supply the
matching signed history when possible; do not re-execute tools to reconstruct a signature.
The in-memory cache also stops selecting the longest of conflicting opaque values.
Different values captured under one scoped tool ID or one message-count slot disable
that recovery entry. Retain actual returned signatures with each call; message count
alone cannot establish that two captures belong to the same response. Message-count
slots are model-family scoped, so switching between incompatible Claude models no longer
replaces the other model's cached value.
For a model-family error, keep the original signed history with its model association and
route it through the matching model family. Do not replace it with the Gemini placeholder.

## Data and recovery

This change does not alter stored formats, account credentials or history filenames.
Existing history files and database records are retained. Previously missing or overwritten
signatures cannot be reconstructed by this change. SignatureStore no longer admits the
known placeholder as real recovery material.
Thought Store recomputes model compatibility from the recorded model using the
existing registry. Broad legacy family labels do not make different Claude
models or a whole Gemini generation interchangeable. Unknown models require
exact normalized names; records without a model remain available for inspection
but cannot supply automatic recovery. Compatible known variants retain recovery.
Ambiguous incoming records are retained separately under the existing session limits.
Restoration does not assign repeated unsigned turns by array order, and it does not
reconstruct an explicitly signed turn from an unsigned record.

A provider rejection remains a failed model request through the existing error path.
The gateway adds no tool execution or retry to repair the missing signature.
Google internal generation wraps only recognized raw Claude signatures in a separate
outbound copy after history restoration. The recognized wrapper is removed for
Claude client output, while caches retain the received upstream value. Unknown,
malformed, noncanonical and additionally wrapped values are unchanged. This does
not repair older corrupted values or validate signatures with the provider.

## Downgrade

There is no format conversion to undo, and older code can read the same persisted formats.
An older version can resume its former automatic-placeholder behavior. This is a code
rollback only; it cannot recover signatures that were never retained. Application downgrade
has not been exercised against a real user profile.

## Verification

Controlled tests check unsigned native Flash/Claude history, explicit signature preservation,
placeholder cache rejection, recovery mapping and unsigned Thought Store restoration. The
Gemini synthetic execution harness checks unary and streaming request bodies.
Model ownership tests cover hot capture, cold hydration, matching and original
request preservation. Isolated production SQLite worker tests cover signed and
unsigned model separation through save, historical ingestion and worker restart.
Part ownership tests cover unsigned mapped tool results, message-local fallback
and preservation of supplied parallel signatures in either alias.
Known-format tests cover one-direction conversion, idempotence, original cache
retention and raw/wrapped association through hot recovery and isolated SQLite
save, historical ingestion and worker restart. Unary and stream transport tests
inspect the serialized request after restoration.
Request-alias tests cover controller errors before account selection, direct public/internal
generation and warmup rejection, equivalent raw/wrapped pairs and unchanged source requests.
Upstream tests cover public/internal unary and fragmented streaming transport, event-boundary
withholding, final events without delimiters, safe 502 errors, unchanged equivalent pairs,
parser limits and four protocol services without retry or account rotation.
Model-gate tests cover resolved Claude/Gemini targets, an unknown registered target,
explicit Gemini placeholder passthrough, Claude placeholder rejection and rejection before
native Gemini account selection.

Live models, installed clients and provider acceptance are deferred to the final acceptance
stage. See the [decision](../../../.agents/notes/implemented/bug-fix/2026-10-18-no-generated-thought-signatures.md)
and [current signature ownership](../../architecture.md#thought-signature-ownership).
The [model ownership decision](../../../.agents/notes/implemented/bug-fix/2026-10-18-thought-record-model-ownership.md)
records the additional source compatibility restriction.
The [known-format decision](../../../.agents/notes/implemented/bug-fix/2026-10-18-known-thought-signature-formats.md)
records the bounded conversion and remaining format-gate obligations.
