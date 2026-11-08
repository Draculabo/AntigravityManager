# Upgrade guide: Read protocol-native model directory fields

Target version: next

## Affected users

Clients reading `/v1/models/claude` now receive Anthropic-shaped model items and page
metadata. Gemini model consumers receive the gateway's registered/family context and
output limits instead of fixed 128,000/8,192 values. OpenAI routes keep their current shape.

## Required action

1. On the Claude directory subroute, read `type`, `id`, `display_name` and `created_at`
   from each `data` item. Replace uses of its former `object`, `created` or `owned_by` fields.
2. Treat `created_at: 1970-01-01T00:00:00Z` as an unknown provider release date.
3. Read `first_id`, `last_id` and `has_more`. This gateway returns its complete directory
   in one page; it does not implement upstream cursor filtering on this subroute.
4. Treat Gemini limits as maintained local gateway specs/fallbacks, not an assurance of
   provider access or actual usage. Exact catalog IDs remain the unambiguous choice.

## Data and recovery

No configuration, credential, account or durable record migration occurs. Model list and
retrieve read the same current directory. A unique case-insensitive spelling can resolve
to its catalog ID; ambiguous names return 404 and require exact spelling. Unknown models
remain errors rather than fabricated metadata.

## Downgrade

No storage restoration is required. Older versions return the former Claude list shape
and Gemini placeholder limits. Client integrations must tolerate or explicitly select
the version's documented response shape; this change adds no dual-shape response.

## Verification

Controlled controller and Nest/Fastify HTTP tests check list/retrieve equality, empty and
ambiguous catalogs, raw mode, registered Gemini limits, authorization and neighboring
OpenAI output. See the [compatibility reference](../../modules/proxy-gateway/compatibility.md)
and [decision](../../../.agents/notes/implemented/feature/2026-10-27-openai-model-metadata.md).
No live provider, installed SDK or cross-version client downgrade was exercised.
