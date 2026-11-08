# Agent Note: Token count value and coverage sources

Status: implemented

## Problem

The shared count owner accepted any JavaScript number as authoritative, including
negative, nonfinite and fractional values. Its internal upstream request contained
only contents/model, while public input could include system instructions and tools.
A successful partial count was labelled upstream for the entire request. Operational
fallback also returned a partial heuristic for media the estimator explicitly could
not count.

## Decision

Require nonnegative safe integer upstream counts; zero is valid. Invalid counts use the
existing unavailable-count failure/fallback policy. Keep the internal endpoint's narrow
wire contract. When system/tools/tool configuration are outside that endpoint's coverage,
return the complete local estimate and stable `upstream-contents-only` reason. Do not sum
a provider contents count with an unexplained heuristic delta. Complete local estimates
with unknown media parts fail with a local 503 rather than manufacturing a total.

The successful upstream operation still uses normal authorization, model selection and
retry ownership. Local coverage failure occurs outside transport retry/error accounting,
so it does not penalize a healthy account or retry an unsupported local calculation.
Cancellation checks precede publication and retain the native count cancellation contract.
Provider billing and generation usage remain independent; no hard-window or compaction
decision is authorized by this estimator.

Anthropic counting follows the confirmed local-default policy: after existing file/media,
schema and mapped tool-history admission, it returns this complete estimate with reason
`anthropic-local`. It does not lease accounts, invoke upstream count retries, update health
or commit session affinity. The HTTP route retains its proxy guard; local success is not
provider access or a generation entitlement. Gemini retains upstream-first counting.
The local count mapper does not apply the generation send window: it counts the complete
submitted admitted history, including historical images, independently of that preference.

## Alternatives considered

- Preserve partial upstream counts as complete: rejected because system/tools are omitted.
- Add a heuristic to the partial count: rejected because its mixed basis is harder to
  interpret and does not have a verified provider tokenization contract.
- Forward generation-only fields to count: rejected by the existing internal endpoint
  contract. A future verified count protocol can replace the approximation at its owner.
- Estimate unknown PDF/video/remote media as zero: rejected because the estimator already
  records that coverage as unavailable.
- Make Anthropic local estimation depend on provider account availability or connectivity:
  rejected because it would retain the remote operation's failure/latency while claiming
  the confirmed local-default behavior. Authentication and input admission remain separate.

## Consequences

Some successful upstream count operations now produce explicitly estimated public results.
Unknown-media fallback returns 503; callers must retry upstream counting or simplify input.
Existing contents-only counts and operational/auth/cancellation classifications are retained.
No storage, schema, credential or account format changes occur. Source headers can be
ignored by an SDK; the gateway cannot make a heuristic equivalent to provider tokenization.

## Verification

Controlled service/controller tests first fail invalid values, full-input source and PDF
coverage cases. Repaired checks retain valid zero and narrow wire requests. Neighbor tests
cover count errors, generation transport, account rotation and cancellation. These synthetic
counts do not establish live provider equivalence or installed SDK handling of source headers.

Controlled Nest/Fastify injection verifies the Anthropic local route returns 200 with no
provider account/request, rejects missing/wrong proxy keys before estimation, and rejects
malformed explicit images. Former Anthropic-only upstream rotation/commit assertions are
removed from those remote-count matrices; Gemini keeps all their retry/commit assertions.
