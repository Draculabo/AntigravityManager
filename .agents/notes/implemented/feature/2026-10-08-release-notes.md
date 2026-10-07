# Agent Note: Release notes before updating

Status: implemented

## Problem

The update notice identifies a newer version without explaining its changes. GitHub Releases already carry the published description, but the previous `updater.json` contains a fixed placeholder. Users need to inspect changes before installation without changing installer-specific update policy.

The [domain glossary](../../../../CONTEXT.md) distinguishes the target release from release notes. [Windows installer-specific automatic updates](../architecture/2026-09-27-windows-dual-updater.md) continues to own installer selection and download behavior.

## Decision

An explicit notice action opens a dialog for the selected target release, including while downloading and before installation. The dialog retains that target when newer notifications arrive. Closing it leaves the notice and update operation intact. Existing manual checks restore a dismissed notice; there is no separate persistent About entry or after-upgrade announcement.

The dialog displays the complete Release body in its original language. Controls, loading, empty and failure states use localized resources. Failed retrieval offers retry and the target release page; an actually empty body shows an empty state. History opens the repository releases listing.

The publishing workflow serializes the Release body into the existing metadata asset. The app-shell resolver reads the selected tag's asset and verifies its version. Missing, invalid or legacy placeholder metadata falls back to the GitHub API for that exact tag. A latest-release lookup cannot supply another version's description. The resolver is independent of Squirrel indexes and NSIS feeds, so description failures do not change download or installation availability.

Feature-owned schemas validate remote data and the typed ORPC boundary. Requests have bounded responses, an overall deadline and cancellation. Renderer query state is transient and keyed by tag; closing the dialog cancels its request, and late responses cannot replace a different target's content.

`react-markdown` and `remark-gfm` provide maintained Markdown parsing and GitHub-style tables, lists and code blocks. Raw HTML is skipped and images become their alternative text and address without network loading. A scoped main-process navigation handler permits HTTPS pages under this repository and GitHub profile-shaped contributor addresses. Other URLs remain text. The general external-link policy remains unchanged.

Current behavior is documented in [architecture](../../../../docs/architecture.md), [security](../../../../docs/security.md) and [testing](../../../../docs/testing.md).

## Alternatives considered

- Automatically opening details interrupts the lightweight update notice; an after-upgrade announcement does not support reviewing before installation.
- Aggregating intermediate releases, summarizing or translating bodies adds content interpretation and retrieval responsibilities beyond this feature.
- A permanent About entry duplicates the existing manual-check flow.
- Requiring notes before downloading makes GitHub content availability a prerequisite for an otherwise available update.
- Using only the live API avoids metadata generation but makes every view depend on its availability and rate limits.
- Parsing the cumulative changelog for empty descriptions adds another content-selection path with different semantics.
- Loading images adds unnecessary external requests. Enabling raw HTML expands the remote-content rendering boundary.
- Widening the generic external-link API grants unrelated renderer features additional navigation privileges.
- Implementing a Markdown parser locally duplicates mature parsing behavior; a renderer dependency provides a narrower maintenance responsibility.

## Consequences

Release metadata is a publication-time snapshot. Editing a published body requires resynchronizing that release's `updater.json` to update the preferred source. Older assets continue through exact-tag API fallback, subject to GitHub availability and rate limits; errors retain retry and browser access.

Markdown dependencies increase the renderer dependency graph. Images and unsupported destinations retain their addresses as text. GitHub profile-shaped links are validated syntactically rather than requiring a separate contributor-membership lookup.

Description retrieval adds a typed app-shell operation without changing the update notification contract, durable storage or installer protocols. Boundary validation and version pinning remain owned by this feature.

## Verification

Focused tests cover exact-tag metadata and API resolution, complete Markdown preservation, empty and failure states, cancellation and stale responses, scoped IPC navigation, image/HTML restrictions, notice dismissal and reopening, and existing update checks. The publication CLI is exercised with multiline Unicode content rather than testing serialization alone.

The focused `npm run test:unit -- run` selection passes 69 tests across nine files, including existing update and external-link regression suites. `npm run type-check`, focused ESLint and formatting checks validate the changed implementation. `vite build --config vite.renderer.config.mts --outDir .vite/release-notes-validation` passes with Sentry uploading disabled. A separate CLI smoke check verifies the generated complete metadata object.

`npm run test:performance -- release-notes.spec.mts`, with `AGM_RELEASE_NOTES_LIVE_TAG=v0.23.0`, passes both isolated Electron checks on Windows. Production UI, renderer IPC and preload run across real MessagePorts. The fixture verifies scrolling, light/dark and narrow layouts, empty content, retry and native cancellation; live mode invokes the production resolver and renders the already published body. The harness substitutes diagnostics and simulates update actions without loading production accounts or running installers. Sandboxed Electron GPU startup fails on this host; the successful run uses normal desktop permissions. `npm run preview:release-notes` exposes the same fixture for manual inspection.

Live GitHub Actions publishing, native browser opening and platform installer execution require separate runtime evidence and are not established by these checks.

The interactive Windows launcher permits its requested GUI window to appear and explicitly shows it after loading. It reports the selected mode/tag and visible-window readiness rather than assuming that spawning Electron displays a window. A real CLI launch and manual inspection confirm the live preview after fixing hidden-window startup.

The repository-wide Agent Note check has an existing failure in `2026-10-04-proxy-account-continuity.md`; it is unrelated to this note. Full formatting also encounters an existing inaccessible installer output directory. The feature uses targeted checks without modifying those unrelated files.
