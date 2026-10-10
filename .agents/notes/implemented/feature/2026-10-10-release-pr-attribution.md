# Agent Note: Reviewed GitHub release stories and attribution

Status: implemented

## Problem

The previous release footer inferred PR numbers and GitHub users from commit text and noreply
emails, then mutated notes during `publish`. Semantic-release clones plugin contexts, so the
GitHub publisher received no footer. Release notes also need a reviewed overview, highlights,
domain summaries, source statistics and contributor credit.

## Decision

Keep the existing semantic-release version rules and GitHub publisher. Replace automatic commit
summaries with a `generateNotes` plugin that reads a reviewed versioned release document. Product
claims are authored and reviewed against source changes; Git and GitHub APIs supply range facts,
PR links, authors and counts. The same rendered Markdown feeds the changelog and GitHub publisher.

Prepare and review the narrative before publication, then resolve attribution during note
generation so all downstream plugins receive the complete content. Keep the manual semantic-release
entry point and existing commit conventions. The implementation adds no dependencies or external
writing service.

The document anchors the previous release tag and reviewed source head. Ancestry and exact source
hashes must still match during generation. Notes-only commits and the generated version/changelog
commit are excluded from source statistics, permitting semantic-release's prepare/regenerate
lifecycle. New source changes invalidate review. Every source commit and associated merged PR
must be covered in domain sections. Out-of-range references and unverified PR mentions fail.

GitHub's commit-to-PR association resolves attribution; commit subjects never guess PR numbers.
Only merged PRs for this repository and release branch qualify. Direct commits retain SHA links
and their resolved GitHub author or unmapped Git name. Verified humans are sorted by contributed
PR count, with bots credited separately. Unmapped Git names receive separate credit and do not
inflate the verified contributor count; no unverifiable identity mapping is attempted.

## Alternatives considered

- Moving the old footer into `generateNotes` fixes propagation but retains unreliable inference.
- GitHub-generated notes provide PR authors but do not supply the target product narrative.
- Changing the commit preset introduces unrelated changes to version selection and commit conventions.
- A second publisher or an AI writing service introduces unnecessary lifecycle or credential scope.

## Consequences

Each release requires a reviewed document committed before manual publication. Missing or stale
notes stop before prepare; network and invalid metadata errors remain explicit and do not expose
provider error text or credential-bearing causes. Read-only requests are bounded and paginated.
Public metadata supports anonymous local drafting; private metadata requires repository access.
Unpushed commits are supported only in explicitly incomplete local previews. Reverting the
generator configuration restores the prior release-content path without a data migration.

## Verification

Local acceptance uses isolated Git repositories and the actual semantic-release loader,
changelog writer and GitHub publisher with controlled metadata and publication transports. It
checks full-body propagation, editorial regeneration, stale review, source coverage, direct/bot
authors, stable/beta/first-release links, metadata pagination, safe failures and the preview CLI.
A real local-history preview reads public GitHub metadata; incomplete attribution is marked.
Neither fixture publication nor preview establishes live publishing credentials.
