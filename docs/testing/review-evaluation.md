# Historical Review Evaluation

This optional procedure investigates a specific reviewer miss, harmful recommendation or
comparative performance claim with confirmed historical defects and repaired controls. A workflow
edit does not require a model comparison. This procedure does not replace current-task acceptance
or change CI, merge permissions or the lesson-promotion threshold.

## Corpus and evidence limits

The evaluator-only [case definitions](../../scripts/review-eval/cases.mjs) own immutable revisions,
source selection, root-cause rubrics, provenance and behavior to preserve. The corpus has five
defects and their repaired controls:

| Defect                      | Confirmed behavior                                                                                                                | Probe limit                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| AppImage patch registration | The patch exists but pnpm does not register it; the repair adds workspace and lockfile registration.                              | Configuration and referenced patch contents, not a Linux build or installer run.                                                                  |
| Quota family tiers          | Argon and 3.8 Flash tiers remain separate; the repair restores conservative family grouping and display names.                    | Historical utility aggregation and presentation with synthetic quotas, not live-provider or Electron UI acceptance.                               |
| Same-profile descendants    | An explicit-profile helper is captured as a main; its exit can invalidate switch ownership.                                       | Historical observer with synthetic Linux snapshots and controlled path/discovery dependencies, not native discovery or account acceptance.        |
| Parent queue maintenance    | Worker-local changes cannot release a parent queue waiting for a final reply; yield replies must retain ownership and accounting. | Historical parent queue with a controlled worker-message transport, not SQLite reclamation or a latency bound.                                    |
| Acceptance snapshot paths   | An isolated HOME retains external absolute snapshot destinations; the repair rejects them before runtime loading.                 | Extracted pre-runtime runner statements and the historical filesystem guard over temporary files and links, not native runtime or account writes. |

Each sample is a focused historical source audit, not a reconstruction of a whole PR. Selected
consumers are included; missing dependencies and linked instructions remain evidence gaps. Fixed
controls are known to lack the target defect, not certified free of every other bug. This small,
public corpus supports within-corpus comparisons, not a production accuracy estimate. Historical
fixes may be in a model's training data, so source isolation cannot guarantee absence of prior knowledge.

Case `paths` select common sources from both revisions. `fixedOnlyPaths` additionally select helpers
introduced by the repair; missing selected sources fail preparation. Tests and decision records that
reveal the repair stay out of reviewer inputs. Boundary probes execute only their pinned modules
with explicit fixture imports, or the runner's extracted pre-runtime statements. The VM is a
fixture mechanism for trusted historical sources, not a sandbox for untrusted code. Actual model
reviews retain the source-only execution and access limits below.

## Prepare isolated inputs

Use the pinned project runtime and installed dependencies. The case revisions must exist in local
Git history; a shallow clone may need an explicitly selected history fetch. Preparation reads Git
objects and the current review skill without checkout, dependency installation or execution of
historical application code. It writes only a new output directory outside the repository and
refuses an existing destination. No model request or network access is part of either command.

For example, choose a new directory under the system temporary directory:

```powershell
$reviewPack = Join-Path $env:TEMP ('agm-review-' + [guid]::NewGuid())
pnpm run review:eval prepare --out $reviewPack
```

Output contains:

- `reviewer/<opaque-id>/`: one sample's source, task and captured review instructions. Variant labels,
  fix commit messages, tests revealing the fix and grading rubrics are excluded.
- `evaluator.json`: evaluator-only source hashes, variants and rubrics.
- `results.template.json`: incomplete result skeleton; it is not evidence of an executed review.

Give a reviewer only one sample folder at a time in a separate workspace/session, with access
restricted to that folder. Keep the original repository, other samples, evaluator files and network
unavailable. A prompt alone is not an access boundary. Use independent context for paired samples
and keep the evaluator answers out of each reviewer context. Do not execute historical lifecycle
scripts or application code to perform the source audit.

The runner creates artifacts; the operator supplies the model/session and enforces access limits.
It does not launch agents or provision a sandbox. Record any isolation or knowledge contamination
and exclude the affected run from a blind comparison.

## Execute and adjudicate

1. Record the exact model/version, effective instruction revision or digest, tools and per-sample
   budget. Use the same source corpus, task, tools and budget for comparisons, changing only the
   reviewer variable under evaluation. When testing a new instruction set, record its exact digest
   and how it supplements or replaces the captured skill. Keep the prepared files unchanged.
2. Save each raw response as a UTF-8 file beside the completed results JSON, or in a child directory.
   Record actual duration and token usage; use `null` when tokens are unavailable.
3. After all responses are saved, the evaluator reads `evaluator.json`. An identified human
   adjudicator checks every finding's file/line, trigger, impact, evidence and proposal against the
   source and rubric. Another model may assist but does not establish correctness.
4. Copy `results.template.json` to a results file, complete run metadata and all sample entries.
   `response` is a relative child path from that file's directory. Use `completed` for a finished
   review, including a clean response, or `unavailable` with a response file explaining the failure.
   A partial review is unavailable, not a clean result. Record every actionable finding, including
   mistaken ones, rather than selecting only findings that match the rubric.
5. Classify each finding using the table below, recording the reason. Zero findings is an empty
   array. Never turn a keyword match, file mention or generic warning into target detection.

| Verdict          | Meaning                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `target-defect`  | Correct causal account of the known defect and its consequence in a defective sample.                                                 |
| `other-valid`    | A separately verified defect outside the target; record its evidence without counting it as target recall.                            |
| `false-positive` | Unsupported or incorrect actionable finding without a demonstrated harmful edit.                                                      |
| `harmful`        | A recommendation that would break correct behavior or undo the intended repair; this category is distinct from other false positives. |

Each finding records `id`, `file`, `line`, `trigger`, `impact`, `evidence`, `proposal`, `verdict` and
`reason`. The runner validates structure, source locations and corpus identity; causal correctness
and transcription completeness remain the adjudicator's responsibility. Different findings may
describe one defect; detection counts each defective sample at most once.

## Summarize and compare

```powershell
pnpm run review:eval score --pack $reviewPack --results (Join-Path $reviewPack 'results.json')
```

Save the JSON command output through the calling tool if a durable report is needed. Scoring reads
the pack/results, verifies source and captured-instruction hashes and hashes raw responses. It
does not modify the pack, invoke a model or determine whether a PR may merge. Reports include
per-sample evidence, detected/total known defects, unavailable samples, false positives, harmful
advice, separately valid findings, duration and nullable token totals. Exit zero means a complete,
structurally valid report, including reports with misses or harmful advice; it is not a quality pass.
Unavailable samples produce an incomplete report and nonzero exit. Invalid or missing evidence fails.

Compare reports with the same corpus digest, inspect metadata and per-case changes, and account
for cost as well as detection and noise. Repeated runs can expose variance; keep every run rather
than choosing the best one. No automatic score threshold exists. A maintainer decides whether a
reviewer change is supported by the evidence; existing contribution risk rules still apply.

`pnpm run test:review-eval` checks the runner with synthetic responses and executes the historical
probes, including rejection of defective versions. It does not measure a model's review ability.
After the evaluation, retain sanitized reports as needed and remove only the operator-owned pack;
the runner performs no automatic deletion or external publishing.

## Add a case

Use the existing [lesson capture](../../.agents/lessons.md) criteria to confirm evidence and cause.
Case selection is separate from promoting a permanent prevention rule. Add only a useful,
nonduplicative case with immutable revisions, a causal rubric, representative triggering inputs,
a repaired control and a probe that distinguishes them. Keep credentials and private logs out of
both inputs and answers. Unconfirmed incidents such as an unexplained diagnostic event stay out.
Update and run the historical probe tests after corpus changes. Any subsequent model comparison
needs fresh reviews of that corpus; changed corpora are not directly comparable by aggregate counts.
