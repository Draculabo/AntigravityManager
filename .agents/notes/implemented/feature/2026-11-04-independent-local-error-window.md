# Agent Note: independent local error window

Status: implemented

## Problem

Normal rotating app/core logs and HTTP audit do not provide the confirmed independent
500 MiB error window. Full sanitized stacks already have a shared projection, but
that projection has no durable owner, capacity admission or complete-stack retrieval.

## Decision

Place feature persistence, Worker commands, management and export under a dedicated
error-diagnostics module. Bootstrap registers a narrow optional logger sink; shared
logging never imports a feature implementation. Importing modules does not open files.
Role-specific version-one SQLite databases keep app/core writers separate and outlive
the gateway. Reuse the existing bounded SQLite Worker and physical write-budget
primitive. Unknown/unowned formats are refused, never reset as a cache repair.

The selected configuration owner resolves one deployment budget and revision,
including the positive AGM environment override. Allocate half to app and the
remainder to core. Each repository receives an explicit role allocation. A missing
role's allocation is not borrowed: this trades utilization for a simple verifiable
aggregate bound without distributed file locks. An app awaiting the selected
configuration owner uses bounded memory fallback rather than assuming another full
500 MiB allowance. Configuration save, allocation application and physical reclaim
have separate status. Unavailable/mismatched sources cannot appear as zero usage or
a completely applied deployment budget.

The role database retains its last admitted maintenance ceiling until reclamation
reaches the lower target. A restart during decrease must not discard the space
authorization needed for bounded deletion/checkpoint work. New writes still use
the reduced allocation. The isolated SQLite restart regression failed with
`disk_budget` before this field was retained and verifies the resumed lower target.

Persist only complete validated sanitized projections, with finite per-record and
queue budgets. Query bounded metadata independently of complete record content.
Capacity eviction removes oldest whole entities in bounded transactions and targets
70 percent, measuring DB/WAL/SHM and conservative write reservations. Busy checkpoints,
unknown size and no-progress pause persistence; they do not clear audit or Thought.
Clear changes capture generation before its control command, rejects older queued
writes and revokes outstanding detail/export capabilities. Terminal close drains
admitted work and reports incomplete flush without changing the original error.

Google physical send errors also reach this independent owner. The process-local
attempt wrapper keeps an actual UUID, operation, available parent reference and optional
real audit handle; it never manufactures a persisted audit row. Completion is once-only
across unary catches and stream close/error paths. Only terminal failures capture actual
Error evidence and known metadata, so a recovered request retains the earlier failure's
stack/cause even with audit disabled. Success, unfinished work, client disconnects and
structured cancellation are excluded. Status/domain/transport evidence takes precedence;
free-form cancellation wording cannot hide a structured authorization failure. Sink
failure is contained without recursive logging or changing retries/protocol output.

## Alternatives considered

- Reuse normal logs or HTTP audit: their content, lifetime and privacy contracts differ.
- Let each role consume 500 MiB: violates the combined deployment window.
- Borrow idle source capacity dynamically: requires a coordinated reclaim/lease protocol
  and adds races without a demonstrated need for the first implementation.
- Unbounded daily files or arbitrary tail trimming: cannot guarantee complete UTF-8
  records, measured admission, transactional clear or bounded retrieval.
- Enable another Sentry submission path: outside local persistence and existing consent.
- Depend on the HTTP final outcome or audit handle for physical failure capture: loses
  recovered errors and disables this independent channel with traffic audit. Independent
  attempt identity preserves evidence without copying provider payloads or account data.

## Verification

Focused checks exercise actual logger-to-owner capture, role allocation, normal-log exclusion,
complete sanitized Unicode stacks/causes, acknowledged persistence and rejected writes,
reopen, pressure/reclaim failure, clear races and terminal close through isolated
SQLite Workers. Verify bounded metadata/content/export, existing destination protection,
configuration provenance and unavailable-source UI through typed owners. The isolated
compiled core preserves the window across gateway stop/start and confirms independent
clear after process restart. Original protocol results and reporting preferences remain
unchanged. The [current reference](../../../../docs/modules/error-diagnostics/overview.md)
owns behavior; [upgrade instructions](../../../../docs/upgrade-guides/next/local-error-window.md)
cover matching owner compatibility 7. Controlled receipts and remaining acceptance
gaps are retained in the original D17 artifact record.

The physical-attempt follow-up first fails controlled audit-disabled/error-sink cases,
then checks once-only error completion, request-local counters, structured cancellation,
authorization precedence and a real GeminiClient endpoint recovery with mocked Axios.
Unary/SSE, signature and fallback HTTP neighbors preserve their original results. This
does not establish installed/provider behavior or invent stack evidence for untyped errors.

## Consequences

Fixed role partitions leave unused capacity when only one role is present. SQLite
maintenance may remain busy or fail to reach its target; report that state and refuse
growth. Native/platform, installed UI and live-provider evidence remain separate from
unit and isolated Worker checks. Source clear and remote atomic file replacement
are not a distributed transaction: remote generation is checked before export and
local revocation before each replacement attempt. Already saved external files
remain outside automatic deletion. The shared atomic writer accepts an optional
owner guard without changing existing callers' replacement/retry semantics.
