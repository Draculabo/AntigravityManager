# GitHub automation

This reference covers PR checks, inactive PR maintenance and optional AI issue triage.
It excludes AI code review, issue translation, CLA signing and release publication.

## Pull request checks

`pr-checks.yml` calls the owned tests, lint, format, React Doctor and build workflows.
Tests and builds retain Ubuntu and Windows coverage. Dependency Review blocks newly introduced
high/critical known vulnerabilities, without a license policy. Dependency Graph must be enabled and
expose the manifest/lockfile diff. An unavailable service is a failed check, not a clean report.

`CI required` requires every child to succeed; failed, cancelled, missing or skipped jobs fail the
gate. After the first remote run, configure the main-branch ruleset to require this check. Reusable
workflows change the former standalone check names: migrate any existing required-check rules
together. Files alone do not update repository rulesets.

The shared runner inspects the PR base/head Git diff, including both sides of renames. Only root
README/CONTRIBUTING/CHANGELOG Markdown and Markdown under `docs/` qualify for the documentation
profile. That profile retains governance and formatting while explicitly reporting application
tests/builds as skipped. Code, configuration, tooling, Skills, unknown/mixed changes and detection
failures retain full checks. Lane commands still run unconditionally. Local invocations and the
existing main-push test workflow retain full checks.

The build lane runs existing core, CLI and unsigned Electron package commands. It does not start
applications, run installers, use accounts, upload artifacts or publish releases. Sentry source-map
upload is disabled. Compilation/packaging does not establish native-runtime or installer acceptance.

## Inactive PR maintenance

The pinned official `actions/stale` action runs daily and supports manual dispatch. It marks PRs
after 60 inactive days and closes them after another 14 days without activity. The `keep-open` label
exempts a PR. Updates remove stale labels according to upstream activity semantics; this is not a
custom human-only detector. Issues are excluded and branches are preserved. The operation budget
is 30 GitHub API operations per run, not 30 closures.

Start with **Maintain inactive pull requests → Run workflow → dry-run: true**. Inspect candidate
logs before retaining scheduled maintenance. Scheduled runs can be delayed or disabled by GitHub
for inactive public repositories. Disable this workflow to stop future maintenance; previously
closed PRs must be reopened individually. No branch recovery is needed because branches remain.

## Enable AI issue triage

Paid triage is off until repository variable `AI_TRIAGE_ENABLED` is exactly `true`.
The official OpenAI JavaScript SDK owns the API transport:

| Setting                | Value                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| Secret `AI_API_KEY`    | Ark or compatible relay key; never commit it                          |
| Variable `AI_BASE_URL` | Optional override, default `https://ark.cn-beijing.volces.com/api/v3` |
| Model                  | `deepseek-v4-1-flash-260910`                                          |
| SDK endpoint           | `/chat/completions` appended to the base URL                          |
| Thinking               | Explicitly disabled                                                   |
| Output                 | JSON object, at most 800 tokens per request                           |
| Deadline               | 45 seconds per request                                                |
| Automatic retries      | Disabled to avoid uncertain additional charges                        |

The base URL must stop at `/api/v3`, without `/chat/completions`. Overrides must be HTTPS without
credentials, query parameters or fragments. Compatibility does not establish model access, regional
availability or pricing; verify those with the provider.

1. Add `AI_API_KEY` under repository **Settings → Secrets and variables → Actions**.
2. Set `AI_BASE_URL` only when overriding the Ark default.
3. Set `AI_TRIAGE_ENABLED=true` after reviewing the external data flow below.
4. Manually dispatch **AI issue triage** with an issue number and `dry-run: true`. This consumes
   tokens but changes no issue labels/comments. Inspect the Actions summary.
5. Repeat with `dry-run: false` to validate write-back. Subsequent newly opened issues run
   automatically while enabled.

Maintainers with write, maintain or admin access can comment `/bot triage` on an Issue to force a
rerun. PRs, bot-authored issues, closed issues and issues labelled `skip-ai` are excluded. Missing
keys fail; there are no mock-success results. Non-maintainers cannot invoke paid manual reruns.

## Data limits and output policy

At most three GitHub title searches use Unicode-preserving keywords. Up to five recent non-PR
issues from a bounded recent response supplement search hits. At most three distinct candidates
are sent to the model, preferring search hits. Retrieval can miss older or differently worded
duplicates; it is not an exhaustive historical/vector search.

The current issue body is clipped to 5,000 Unicode characters and each candidate body to 500.
Titles are included. The model receives neither repository source nor complete issue history,
downloaded attachments or a GitHub token. Classification/comparison use separate requests; no
candidates means no comparison request. No automatic answer generation or follow-up chat runs.
Manual reruns cost more tokens. Input limits are not a monthly spending cap; use provider key
limits for a hard budget.

Allowed types are `bug`, `enhancement`, `documentation` and `question`. Optional area labels cover
cloud-account, proxy-gateway, antigravity-runtime and app-shell. Write-back creates only missing
labels from this deterministic allowlist, preserves an existing human type, and never assigns
priority, closes an issue or automatically labels it duplicate.

Invalid/truncated/oversized JSON, unknown labels and invented candidate numbers fail before
write-back. Full-content fingerprints reject results if text changed, including edits past the
clipping limit. Reruns update one action-authored comment; user-authored marker lookalikes do not
count. Matching completed fingerprints avoid repeated analysis unless explicitly forced.

GitHub writes are not transactional. Labels can succeed before a comment fails. The run fails;
a rerun preserves labels and updates a bot comment when an earlier request succeeded but its
response was lost. Failed runs do not prove there were no effects. Exactly-once execution is not
guaranteed for provider calls or concurrent GitHub changes.

## Trust, recovery and verification

Analysis has read-only GitHub permissions; only its inference step gets the model key. A fresh
write-back job has issue-write permission without the model key. Both run default-branch scripts
without persisted checkout credentials; PR code never executes in this workflow. Issue content is
untrusted data, not executable instructions. Logs expose token counts and failure status, not raw
provider errors, credentials or request bodies.

Issue text goes to the configured external provider. Clipping is not secret detection: keep tokens,
private logs, account databases and backups out of public issues. Provider retention/billing rules
apply. Set `AI_TRIAGE_ENABLED=false` to stop future paid runs; existing labels/comments remain.
Disable stale maintenance separately. To recover from incorrect change selection, restore full
checks without suppressing failures or removing platform coverage.

`pnpm run test:automation`, `pnpm run check:automation`, `pnpm run test:quality` and
`pnpm run check:quality` exercise synthetic SDK transport, boundaries, recovery and workflow
contracts. They neither call Ark nor write GitHub. Remote scheduling, fork permission behavior,
Dependency Graph, platform packaging and real provider usage need separate acceptance evidence.
