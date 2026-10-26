# Agent Note: Thought record model ownership

Status: implemented

Scope: D04 controlled slice for recorded model compatibility, not signature format recognition.

## Problem

Thought Store restoration accepts broad `claude` or `gemini-3` source families and
accepts missing families. Capture, history ingestion and SQLite saving can merge
records with the same tool ID or signature across incompatible models. The more
precise compatibility policy already used by SignatureStore is not enforced there.

## Decision

Thought Store reuses the existing signature model registry policy. It resolves
compatibility from each record's model and the routed request model, ignoring
legacy broad `sourceFamily` values as compatibility evidence. Known compatible
variants share their registered canonical model; unregistered models require an
exact normalized name. Missing model provenance cannot authorize recovery or
merging. Normalization accepts the native `models/` resource prefix.

The same policy gates restoration, hot capture merging, historical matching,
cold snapshot merging and SQLite saving. Equal signatures cannot override an
incompatible model. No schema, serialized shape, credential or encryption change
is required. Existing records remain readable and are not rewritten.

This is source association, not format recognition or cryptographic verification.
Imported client history still uses the routed request model context; recognition
of incompatible signature formats at that boundary remains a separate D04 task.

## Alternatives considered

- Restrict only restoration: rejected because writes can already overwrite the
  original model and reasoning before restoration runs.
- Trust historical `sourceFamily`: rejected because it can denote all Claude
  models or a whole Gemini generation.
- Discard all history on a model or account change: rejected because compatible
  histories and independent healthy records remain useful.
- Infer source from signature length or opaque bytes: rejected; known format
  classification has a separate owner.

## Consequences

Some legacy histories lose automatic recovery when their model is missing or
their formerly broad family is incompatible. The client can send its original
signed history or begin a new conversation. Existing files stay available for
diagnosis; this change cannot reconstruct overwritten provenance. Recovery does
not execute tools or add retries. See the
[upgrade guide](../../../../docs/upgrade-guides/next/preserve-tool-signatures.md).

## Verification

Focused regressions exercise different Claude models, Gemini models within one
generation, missing provenance, unknown models and known compatible variants.
They check unchanged requests on rejection and complete restored parts on a
compatible match. Service tests cover hot capture and cold hydration.

The production worker tests save and ingest signed and unsigned histories,
restart the worker, compare retained model/reasoning pairs and confirm replay
idempotence. Compatible registered variants still merge. Native SQLite uses
isolated databases and a build of the production worker, with no user profile
access. Live provider and installed client acceptance remain deferred.
