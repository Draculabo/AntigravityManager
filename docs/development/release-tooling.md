# Release Tooling

This guide owns release-note generation, preview and publication prerequisites. Ordinary contributions follow [Contributing](../../CONTRIBUTING.md).

Run commands from the repository root unless a step specifies another directory.

## Release notes

The GitHub Release workflow runs semantic-release, selects the version using the existing
Conventional Commits rules, and generates release notes automatically. No versioned JSON
release document or manual review step is required. The generated Markdown is supplied to
both GitHub Releases and `CHANGELOG.md`.

The generator reads the exact Git range from the previous release tag to the release head.
It groups changes by product area, uses verified merged PR titles when available, and retains
commit descriptions for direct changes. A shared PR appears once while all of its source
commits remain covered. Breaking changes, features, fixes and performance changes receive
priority in the highlights. The overview names the affected areas; it does not invent product
claims or upgrade instructions. Output quality depends on descriptive commit and PR titles.

GitHub APIs supply PR links, authors and counts. Only merged PRs targeting the release branch
in this repository qualify. Direct commits link to their SHA; unmapped authors retain their
Git name, and bots receive separate maintenance credit. Commit text and email addresses never
infer PR numbers or GitHub identities. Generated version/changelog commits are excluded from
source statistics, so semantic-release regeneration keeps the same story after preparation.
New source commits are included automatically.

Local preview is optional and does not publish, create tags or change package versions:

```powershell
node scripts/release/prepare-release-notes.mjs preview --base v0.24.0 --version 0.25.0 --output artifacts/release-notes/v0.25.0.md --anonymous
```

Replace the base and expected version for the actual range. Omit `--base` for a first release;
beta previews use their own previous tag and expected version. Add `--head <ref>` to select an
exact source ref. The command refuses to overwrite existing output. `--local` permits unpushed
commits only in a preview and marks their attribution as incomplete; publication requires
verified GitHub metadata for every source commit.

Metadata requests prefer `GH_TOKEN` over `GITHUB_TOKEN`, have a 15-second deadline and reject
redirects. Public metadata can be read anonymously; private repositories require access.
Network and invalid metadata errors stop note generation and remain credential-safe. The
Release workflow uses its existing publishing token; no AI service or additional key is needed.

Run `npm run test:acceptance -- release notes` for local acceptance. It exercises the actual
semantic-release loader, changelog writer and GitHub publisher with isolated Git repositories
and controlled publication transports, including a repository with no version JSON. The Release
workflow runs this check before publication. Live credentials and a real release remain separate
environment-dependent checks.

The release publisher installs the locked project dependencies in its own job with `npm ci --include=dev --ignore-scripts --no-audit --no-fund`. It requires the JavaScript acceptance dispatcher and YAML parser, but processes prebuilt artifacts without downloading Electron or rebuilding native modules. Update-feed checks run before release creation or asset upload.
