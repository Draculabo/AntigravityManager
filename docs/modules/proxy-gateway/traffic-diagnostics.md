# Traffic attempt timing and HAR export

Traffic Monitor's request detail shows each recorded physical upstream attempt.
Selecting an attempt selects its own captured bodies. A missing upstream body is
not replaced by the incoming request body.

## Attempt stages

The optional version-1 timing object stores upload completion, response headers,
first response byte and first valid output, in milliseconds from admission of that
physical attempt. These observations overlap and are not added to total duration.
Heartbeats, usage-only frames and thinking do not count as valid output. A measured
zero is valid; an unobserved stage and historical rows display unknown.

Earlier-attempt time sums the recorded durations of preceding attempts. An unknown
preceding duration makes that total unknown. This sum excludes unrecorded selection,
scheduling and backoff, and is not the full request latency before the current send.

## HAR export

The **Export HAR** action is available for settled HTTP request details. It opens
the native save dialog and writes through the currently selected audit owner.
Cancellation does not read body content. Concurrent clicks do not start duplicate
exports. A failure reports that completion could not be confirmed and permits retry.

The UTF-8 HAR 1.2 file contains one incoming request and each recorded upstream
attempt. It uses saved sanitized headers and paginated body representations.
Structured credential headers and URL credentials stay redacted. Captured text can
still contain private user-authored content, so review the file before sharing it.
The cURL credential opt-in never applies to HAR.

Capture metadata records missing or expired bodies, stored and logical byte counts,
partial state, and representation. Reconstructed SSE is identified as a stored
representation rather than original wire bytes. Missing capture is not reconstructed
from another exchange. An active or changing request fails export rather than
producing a claimed complete snapshot.

Older records do not retain an absolute incoming origin, HTTP version, or upstream
HTTP method. Missing values remain explicit. A relative incoming target is preserved
in `_agm.capturedUrl`; the HAR URL uses the reserved `unknown.invalid` origin and
sets `_agm.originKnown` to false. That placeholder is not a captured destination.
The unknown HTTP method and version are empty strings. Transport phases use `-1`.
HAR `time` retains the measured audit operation duration, with a comment explaining
that the unavailable transport phases do not provide a complete sum. Unknown total
duration uses zero only as a required-format placeholder, with `_agm.durationMs`
remaining null. `_agm.timing` retains measured attempt stages. These stages are not
misrepresented as DNS, connect, send, wait or receive measurements. Some strict
consumers may reject unknown required transport phases; common HAR schemas accept
`-1`, but this export does not promise complete browser-style network timing.

The owner streams JSON-escaped body chunks to a private sibling temporary file,
enforces the existing 100 MiB aggregate export cap, synchronizes and closes the
file, then atomically replaces the destination. Body-page snapshot checks and a
final detail snapshot check must succeed before replacement. Pre-replacement
failures retain the destination and remove partial temporary output. Body retention
or request deletion during export can cause a retryable failure.

## Storage and mixed owners

Audit schema 7 adds a nullable versioned timing column to upstream attempts. Existing
schema-4, schema-5 and schema-6 data is migrated after a verified backup; historical
rows have unknown timing. Desktop and Core require owner compatibility 11 for the
new export operation. Upgrade both together. See the
[upgrade and recovery guide](../../upgrade-guides/next/physical-attempt-usage.md).
