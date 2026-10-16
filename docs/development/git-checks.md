# Local Git Checks

This guide owns hook installation, automatic checks and recovery. Hook configuration and the existing testing policy are unchanged.

Run commands from the repository root unless a step specifies another directory.

## Local Git checks

The locked Lefthook development dependency installs the hooks during normal dependency installation.
The project `prepare` script also runs the guarded installer; after `npm ci --ignore-scripts`, run
`npm run hooks:install` explicitly. CI and production installs skip the project installer.
The installer skips source directories that are not their own Git checkout root, refuses custom
`core.hooksPath` settings and unmanaged pre-push hooks, and never resets Git configuration or uses
force installation. A plain checkout and its linked worktrees share Git's hook directory; each
active checkout must have the project configuration, scripts and development dependencies available.
The dependency's own install step runs before `prepare` and can already preserve an existing hook
as `.old`. The guarded installer also refuses a preserved pre-push hook because it has not been
integrated into the configured jobs. Use the recovery command below to restore it before resolving
that integration; a failed install does not establish that the previous push policy is active.

[lefthook.yml](../../lefthook.yml) owns the configured jobs:

| Hook         | Automatic evidence                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pre-commit` | Staged whitespace; Agent and quality contracts for affected governance paths; ESLint on staged code; then the preserved pre-commit hook if one exists. |
| `pre-push`   | `npm run type-check` for each invocation, including new branches.                                                                                      |

The governance selector reads NUL-delimited index paths and treats additions, deletions and both
sides of renames as affected. It covers Agent instructions, Agent Notes, project Skills, Markdown
under `docs`, the script guide, the validator, hook/quality scripts, package metadata, Lefthook and
the test/lint/format workflow configuration. Whitespace and code lint inspect the index. Code lint
uses the current ESLint configuration and does not apply fixes; staged deletions are excluded and
renamed source is checked at its new path. Agent/quality contracts and type-check read the current worktree;
when it differs from the staged or outgoing revision, establish the intended revision's evidence
separately before claiming it passes. These hooks do not replace focused behavior or platform tests.

The Lefthook adapter disables automatic stashing and staging for pre-commit because these jobs only
check state. It does not format files or stage fixes. Native Lefthook installation preserves a prior
pre-commit hook as `pre-commit.old`; the final job executes that hook, retaining existing CodeGraph
behavior and its original failure policy. Reinstallation preserves the backup. Keep that private
backup available for recovery rather than committing its machine-specific contents.

To run a gate manually, use `npm run hooks:pre-commit` or `npm run hooks:pre-push`.
Fix the reported failure before retrying; do not bypass a failed gate without explicit user direction.
Use `npm run test:git-hooks` after changing hook configuration, installation or dispatch behavior.
It installs real hooks in temporary repositories, exercises rejected commits and a local bare-remote
push, and verifies preservation and skip behavior. `npm run check:ci` includes these tests.

Recovery uses the installed dependency's `node node_modules/lefthook/bin/index.js uninstall` command,
which restores preserved hooks; inspect the resulting hooks before continuing. Custom hook paths
need an explicit integration decision rather than an automatic reset. GUI Git clients also need
Node on their executable path; a successful terminal check does not establish GUI configuration.

## Hook verification

For Git hook installation, configuration or dispatch changes, run `npm run test:git-hooks` plus
`npm run check:agent-contracts`, `npm run check:quality` and focused formatting. The integration fixtures exercise installed
Lefthook hooks through real temporary-repository commits and local bare-remote pushes, including
failed checks, staged additions/deletions/renames, partial staging, preserved hooks and recovery.
They also verify that staged lint errors block a commit despite a corrected worktree, that valid
staged code can commit without consuming invalid unstaged edits, and that CI changes trigger the
quality contracts. Neither lint nor the adapter stages fixes or creates a stash.
They do not push to GitHub or establish GUI Git environment support. [Local Git checks](#local-git-checks)
owns the automatic gates; CI includes their integration tests through `npm run check:ci`.
