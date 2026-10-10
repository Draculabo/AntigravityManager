# Agent Note: Automatic GitHub release stories and attribution

Status: implemented

## Problem

The release workflow must publish from its selected Git history without requiring a manually
prepared version document. A reviewed-document gate prevents that operation when semantic-release
chooses a new version. The previous attribution footer also guessed PR numbers and GitHub users
from commit text and emails, then mutated a cloned plugin context during publication.

## Decision

Keep the existing semantic-release version rules and GitHub publisher. Generate the complete
release story in `generateNotes` from the exact source range and verified GitHub metadata.
The changelog and GitHub publisher receive the same Markdown through the plugin return value.
The generator requires neither a versioned JSON document nor an external writing service.

Use source descriptions and verified PR titles for the narrative, group changes by product area,
and prioritize breaking changes, features, fixes and performance changes in highlights. Avoid
inventing user benefits or upgrade instructions that cannot be established from those titles.
The optional local preview uses the same generator; publication requires complete attribution.

Exclude only the generated version/changelog commits for the selected version. This keeps
semantic-release's prepare/regenerate lifecycle stable while including new source changes
automatically. Domain sections must cover every source commit and associated merged PR.
PR and identity links come from GitHub metadata rather than inferred commit text or email.

## Alternatives considered

- A reviewed version document supplies richer writing but adds a manual prerequisite to every release.
- An AI writing service adds credentials, cost and non-deterministic output without being required
  for source-derived summaries.
- GitHub-generated notes supply PR details but omit the desired domain grouping and direct commits.
- Changing the commit preset introduces unrelated changes to version selection and commit conventions.
- A second publisher adds lifecycle complexity without fixing note propagation.

## Consequences

The existing Release workflow remains the entry point for automatic publication. Descriptive
commit and PR titles determine narrative quality; curated product announcements remain separate
from this release path. The obsolete reviewed-document reader and draft commands are removed.

Network errors or invalid GitHub metadata stop generation before preparation and publication.
Requests remain bounded, paginated and credential-safe. Unpushed commits are accepted only in
explicitly incomplete local previews. Rolling back the generator requires no application data
migration; the generated Markdown keeps the existing release-content contract.

## Verification

Local acceptance uses isolated Git repositories with no version JSON and the actual semantic-release
loader, changelog writer and GitHub publisher with controlled metadata and publication transports.
It checks complete note propagation, stable regeneration, automatic inclusion of new source changes,
source coverage, PR deduplication, direct/bot authors, first/beta links, metadata pagination,
safe failures, literal source titles and the preview command. The workflow runs this acceptance
before publication. A live preview can read public GitHub metadata without publishing a release;
neither fixture publication nor preview establishes live publishing credentials.
