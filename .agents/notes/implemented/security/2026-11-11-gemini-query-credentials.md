# Agent Note: Gemini query credentials and request identity

Status: implemented

## Problem

Gemini callers can place their proxy key in a query parameter. The existing gateway reads only
header credentials, so these callers fail authentication. Accepting the query in a guard alone
would let authentication and header-based tenant/cache/Thought identity disagree. The existing
audit metadata sanitizer also does not recognize a bare query parameter named `key`.

## Decision

The Gemini HTTP ingress normalizes a single query credential into the existing header identity
path before compressed-body admission and the first audit identity calculation. Recognized
header credentials keep precedence, including an incorrect header over a correct query key.
Only Gemini route prefixes admit query authentication. Management, OpenAI and WebSocket
authentication keep their current contracts.

Query credentials have their own metadata boundary. New audit writes and historical read
projections redact URL/query keys; cURL and HAR apply the same policy when exporting retained
records. Diagnostic text also covers encoded query parameter names. An ordinary business
payload field named `key` does not acquire credential semantics.

## Alternatives considered

- Extending credential extraction to accept a URL at every call site would spread the change
  through stable identity owners and make a missed caller fall back to anonymous identity.
- Reading query credentials only in the guard would authenticate requests without establishing
  matching cache and Thought ownership.
- Marking every JSON property named `key` as sensitive would rewrite ordinary tool/content
  data. The query-only boundary avoids that change.
- Extending query credential extraction to management and other protocols would
  broaden authentication beyond the approved Gemini compatibility use case.
- Rewriting historical databases and backups is outside this change. Read projections and
  exports can redact values without a data migration or loss of retained records.

## Consequences

Header/query requests using the same key have the same one-way credential identity. Different
keys remain separate. API key validation, network policy and credential rotation retain their
existing owners. Query admission does not grant a new upstream identity or bypass provider
authorization.

Historical originals on disk and existing backups can still contain previously captured query
values. The change prevents new captures and returned/exported projections from exposing them;
it does not erase clipboard history, external logs or old backups. The profile's access and
retention policy still applies. See the [gateway security reference](../../../../docs/modules/proxy-gateway/security.md#query-credential-metadata).

## Verification

The D23 task record (local artifact `d23-implementation.md` in the 2026-11-07 review collection)
records the selected HTTP/gzip/identity, metadata and export checks, negative controls and final
results. Local upstream substitutions and injected audit workers do not establish live-provider
or native SQLite acceptance. Real Gemini client/provider execution remains a separate check.
