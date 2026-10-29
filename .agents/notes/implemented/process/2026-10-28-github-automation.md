# Agent Note: GitHub issue and pull request automation

Status: implemented

## Problem

Issue classification and duplicate lookup repeat maintainer work. PR workflows lack a complete
merge gate, dependency-change review, build verification and inactive-PR maintenance. Untrusted
issue/PR content must not receive executable control over provider keys or GitHub write tokens.

## Decision

Keep quality-lane ownership, add a reusable build lane and orchestrate PR checks. Lane invocations
remain unconditional. Only positively allowlisted Markdown-only PR diffs reduce application
coverage; failures/unknown scope retain full checks. A stable gate requires every child to succeed.
Branch rules are configured separately after remote acceptance.

Reuse official actions/stale for 60-day reminders plus a 14-day closing period, and official
Dependency Review for new high/critical vulnerabilities. Exclude issues from stale cleanup,
preserve branches, and retain upstream activity semantics rather than a second stale algorithm.

The supplied endpoint is Ark Chat Completions. Reuse the official OpenAI SDK for transport rather
than a handwritten HTTP client or agent loop. Preserve the requested model and input limits,
disable thinking/retries, and use separate classification/comparison calls. Repository code owns
bounded retrieval, policy validation and GitHub write-back. A variable explicitly enables paid
processing; absent keys never produce mock-success results.

Separate model credentials from issue-write permissions in different jobs. Run default-branch
code, validate model output, recheck full-content fingerprints and update the bot comment.
Current operation belongs in [GitHub automation](../../../../docs/development/github-automation.md).

## Alternatives considered

**Codex Action.** Its Responses/agent contract differs from the provided Chat Completions endpoint
and adds tool execution to a bounded text-classification task.

**An all-in-one community Action.** Examined candidates use lexical matching or strip Chinese
search terms; their defaults do not meet the requested retrieval and manual-decision policy.
The official SDK removes custom transport while retaining a small owned policy layer.

**Conditional required jobs or per-module test pruning.** These can leave pending/skipped gates or
miss shared consumers. Keep unconditional lanes and start with docs/full only.

**Close duplicate issues or publish builds.** Both exceed the authorized scope.

## Consequences

The SDK is a pinned development dependency, not application runtime infrastructure. Builds take
additional PR time without publishing artifacts. Provider availability/pricing remain external;
bounded inputs are not a spending cap. Label/comment writes can partially succeed and need
idempotent recovery rather than a fictitious transaction.

Reusable workflows change required-check names. Operators must update rules after a representative
remote run. Disabling workflows does not reopen PRs or remove existing labels/comments. Application
profiles, schemas and release workflows are unchanged.

## Verification

Automation fixtures exercise the real SDK with synthetic transport, Unicode clipping, permission
denial, output validation, stale-content rejection and comment recovery. Quality fixtures exercise
real Git rename/diff behavior and retained failure/platform contracts. Executed commands and results
are reported with the change. Provider calls, GitHub writes, scheduling, fork policy and platform
packaging require remote/environment acceptance; synthetic checks do not establish those outcomes.
