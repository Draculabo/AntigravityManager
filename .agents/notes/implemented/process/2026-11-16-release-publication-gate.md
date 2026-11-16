# Agent Note: Publish verified release assets with the release notes

Status: implemented

## Problem

The formal workflow published release notes before the GitHub release event started packaging.
A packaging failure could leave the new version publicly visible with no installers.

## Decision

The formal workflow freezes the candidate version, source and notes, then invokes the shared
packaging workflow. After six target artifacts pass verification, the protected publication job
records the Git release and stages all attachments on a draft. It reads back asset names, sizes
and SHA-256 digests before publishing with the Actions token. Manual packaging and the existing
published-event attachment path continue to use the shared packaging workflow.

## Alternatives considered

Publishing first and filling attachments from a release event exposes a partial delivery. Running
the official and event-driven builds independently also duplicates packaging work after every
successful release. The explicit reusable workflow makes packaging a dependency of publication.

## Consequences

Git release metadata can exist while the draft is private. The version commit records the source
and frozen notes for recovery after Actions artifacts expire. A maintainer can resume or abandon
the candidate without moving its tag. Notes for a subsequent version start at the most recent
published release on its channel to include changes that were never delivered. The stable Windows
feed is activated after release assets become public. Maintenance of older releases is scoped to
their attachments.

## Verification

The release artifact workflow contract verifies the dependency and write order. Delivery fixtures
cover incomplete uploads, resumption, remote digest mismatches, manual replacement and notes after
abandonment. The [delivery runbook](../../../../docs/development/build-and-package.md#release-workflow-verification)
owns the six-target rehearsal and isolated live exercise. Remote publication evidence is pending.
