# Agent Note: Private Responses media storage

Status: implemented

## Problem

Inline image and audio bytes embedded in Responses history were at risk of
being copied into durable JSON or being removed by a generic recursive history
filter. That made cold recovery expensive and could also alter ordinary tool
arguments containing data URLs.

## Decision

Inline image and audio bytes in OpenAI Responses history are stored in a
private, bounded content namespace. Durable Responses JSON contains a validated
reference with an encoding and media prefix rather than the original Base64
payload. Restoring a missing or expired reference returns HTTP 410 so callers
can start a new conversation or resend the media.

The transform only visits protocol media fields. It deliberately leaves
`function_call.arguments` and other ordinary tool parameters unchanged. Data
URLs and Base64 are checked for canonical encoding before a private record is
written.

## Alternatives considered

Keeping raw Base64 in every durable turn was rejected because it multiplies
serialization and disk usage. Reusing the public Files API was rejected because
its user-visible access and deletion semantics do not match private conversation
references. A generic recursive string replacement was rejected because it
changes tool arguments and source text.

## Consequences

Responses history contains opaque private references and requires the private
content store during restoration. Missing or expired content is an explicit HTTP
410, so callers receive a diagnosable recovery failure. Send-window omission and
historical retention remain independent and cannot silently delete the original.

## Security and lifecycle

References are opaque content IDs validated on restore. The store does not
print media bytes or URLs to diagnostics. Window omission and historical
retention remain separate concerns; sending a smaller history view does not
delete the private original.

## Verification

The focused media-store tests cover image/audio externalization and restoration,
tool argument preservation, missing-content HTTP 410 behavior, and
non-canonical Base64 rejection. Real cold-restart and live-provider acceptance
remain deferred by the D01–D29 rollout contract.