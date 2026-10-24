# Contributing to Antigravity Manager

Contributions can improve the desktop application, local API gateway, documentation and
translations. This guide covers choosing a task, preparing a change and submitting a pull
request. Follow the [Code of Conduct](CODE_OF_CONDUCT.md) when participating.

## Choose a contribution

Search existing issues and pull requests before opening a new one.

| Contribution                          | Where to start                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report a bug                          | [Bug report](https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md): include the app version, platform and reproducible steps.       |
| Suggest a feature                     | [Feature request](https://github.com/Draculabo/AntigravityManager/issues/new?template=feature_request.md): explain the problem, use case and current workaround. |
| Improve documentation                 | Make a focused correction, or use the [documentation index](docs/README.md) to find the owning guide.                                                            |
| Fix code or improve the UI            | Start with an [existing issue](https://github.com/Draculabo/AntigravityManager/issues), nearby tests and the [module index](docs/modules/README.md).             |
| Improve translations                  | Follow the existing `react-i18next` resources in `src/localization` and preserve translation keys and placeholders.                                              |
| Ask a question or discuss an approach | Use [GitHub Discussions](https://github.com/Draculabo/AntigravityManager/discussions).                                                                           |
| Report a security vulnerability       | Follow [private reporting](SECURITY.md#reporting-a-vulnerability). Do not post vulnerabilities or credentials in public issues.                                  |

Documentation, reproduction steps and testing feedback are useful contributions even without
a code change. If an issue has no clear implementation direction, describe the proposed scope
before investing in a large change.

## Before starting

Small bug fixes and documentation corrections can go directly to a pull request. Discuss new
features, substantial UI changes and cross-module refactors in an issue or discussion first.
Keep each PR focused on one problem so its behavior and validation are easy to review.

For changes to credentials, authentication, IPC, persistence, installers or updates, read the
[security reference](docs/security.md) and describe compatibility, partial effects and recovery
before implementation. Follow the [upgrade guide rules](docs/upgrade-guides/README.md) when
users must take action after an incompatible change.

## Set up for development

Use Node.js `24.22.0`, pnpm `10.34.6` and the checked-in `pnpm-lock.yaml`. Do not add a second
package manager or lockfile. Native module prerequisites depend on the target platform; see
[Development](docs/development.md#prerequisites).

1. Fork the repository on GitHub.
2. Clone the fork and add the original repository as `upstream`:

   ```powershell
   git clone https://github.com/YOUR_USERNAME/AntigravityManager.git
   cd AntigravityManager
   git remote add upstream https://github.com/Draculabo/AntigravityManager.git
   git switch -c fix/describe-the-problem
   ```

3. Follow the [quick start](docs/development.md#quick-start) to install dependencies and start
   Electron. Documentation-only work does not require launching the application.

The default development launch is not an isolated test profile. Read the quick-start data
precautions before using account operations. Routine documentation and local unit tests do not
require provider credentials; live-account and installer checks have separate prerequisites.

## Find the owning module

| Area                                    | Location and guidance                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Feature UI, hooks and business logic    | `src/modules/<feature>`; use the [module index](docs/modules/README.md).                            |
| Routes                                  | `src/routes`; do not edit generated `src/routeTree.gen.ts`.                                         |
| Generic UI                              | `src/components`; follow the existing Radix and Tailwind patterns.                                  |
| Cross-feature primitives                | `src/shared`; move code here only when it has a real second consumer.                               |
| API gateway                             | `src/modules/proxy-gateway/server`; see the [gateway guides](docs/modules/proxy-gateway/README.md). |
| IPC, runtime and persistence boundaries | Read [Architecture](docs/architecture.md) and the nearest `AGENTS.md` before editing.               |

Keep renderer code separate from main-process, filesystem and database implementations. Use
the existing typed preload/IPC/ORPC surface for cross-process operations. Place user-visible
strings in the existing localization resources rather than embedding them in components.

## Make a focused change

- Inspect the owning implementation and nearby tests before editing.
- Add a regression check for a bug fix, or verify the new behavior for a feature.
- Preserve public protocol behavior unless the change explicitly addresses that contract.
- Update the owning reference when behavior or an operation changes. Avoid duplicating rules
  already maintained in architecture, testing or security documentation.
- Keep unrelated formatting, dependency upgrades and file moves out of the PR. Format only
  files changed for the task, and review the resulting diff.
- Do not commit credentials, account databases, private logs, environment files or generated
  application packages. Use synthetic data in fixtures and redact screenshots.

Use TypeScript and the existing ESLint/Prettier configuration. Comments should explain contracts
or non-obvious decisions. Follow [Conventional Commits](https://www.conventionalcommits.org/),
for example `fix(proxy-gateway): preserve model error responses` or
`docs(contributing): clarify local setup`.

Keep the branch current with its intended PR target. For work targeting `main`, fetch
`upstream` and review changes from `upstream/main` before integrating them. Stage only the
files or hunks belonging to the contribution; inspect the staged diff before committing.

## Validate your change

Use the [change-to-evidence matrix](docs/testing.md#change-to-evidence-matrix) to select checks.
The following table is a navigation aid, not a replacement for that matrix.

| Change                                    | Validation entry                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Documentation                             | [Contributor checks](docs/testing.md#checks-for-a-contribution): contracts and formatting of changed files. |
| Utility, mapper, component or hook        | Owning test file; add caller tests when the contract changes.                                               |
| Shared types or process/module boundaries | Type checking and affected consumer/integration tests.                                                      |
| Gateway, persistence or lifecycle         | The owning integration tests and the corresponding matrix row.                                              |
| Native modules, installers or updates     | The platform-specific procedure linked from the testing guide.                                              |
| Real accounts or providers                | The owning acceptance procedure, including prerequisites, effects and cleanup.                              |

Do not run every test or installer check for an unrelated local change. Do not hide a known
failure by selecting only passing tests. Record checks not run and explain why; a mock, build
or local hook does not prove native or live-provider behavior.

The [local Git checks](docs/development/git-checks.md#local-git-checks) provide automatic baseline checks.
They do not replace behavior tests. `pnpm run format` checks the entire workspace, while
`pnpm run format:write` modifies it; prefer explicitly named changed paths for a focused PR.

## Open a pull request

Push the contribution branch to the fork and open a PR against the agreed target branch
(`main` for ordinary contributions). The [PR template](.github/PULL_REQUEST_TEMPLATE.md) asks for:

- The problem, related issue when applicable, and resulting behavior.
- Screenshots or a short recording for visible UI changes, with private information removed.
- The tested revision/artifact, environment, commands or manual checks, results and sanitized evidence.
- Risk, affected consumers/platforms, persistent or external side effects and recovery evidence.
- Checks not run, known limitations and what the available evidence cannot establish.

Documentation-only changes need documentation evidence, not an unrelated application test run.
For runtime changes, distinguish a focused local pass from full CI or platform acceptance.

### Risk and recovery

Authors propose a risk level; reviewers confirm it from changed behavior and consumers, using
sensitive paths as a prompt to investigate rather than a substitute for that assessment.

| Risk   | Typical behavior                                                                                       | Review and evidence                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Low    | Copy or local pure transformations without external side effects                                       | Owning checks and semantic review.                                                               |
| Medium | Business policies, protocol conversion, asynchronous lifecycle or shared contracts                     | Affected consumers and failure paths, with maintainer confirmation.                              |
| High   | Credential/account writes, durable formats, updates/installers or CI/release execution and permissions | Relevant native/platform evidence, recovery evidence and explicit human maintainer confirmation. |

An unverified high-risk path remains a stated evidence gap for the maintainer to resolve. Automated
review does not supply required human confirmation or authorize merging.

Describe whether a code revert restores behavior and whether local state, data or external effects
also need recovery. Record compatibility and downgrade limits. Distinguish executed recovery from
an untested procedure; use the existing upgrade guide rules for incompatible changes. Small changes
can give a short explanation, including why no state recovery is needed.

## Review and follow-up

Respond to review feedback with the resulting change or an explanation of the trade-off.
After updates, rerun checks affected by the new diff and update the PR's validation section.
Keep failed, pending and unverified checks distinct from passing results.

The [review skill](.agents/skills/agm-code-review/SKILL.md#review-rounds-and-resolution) owns review
rounds, finding IDs and escalation. Keep its compact record in the task report or authorized PR
discussion rather than adding a repository file per review. Maintainers resolve disputed findings
and explicitly accept limitations; reaching a round limit never clears an unresolved defect.

If the scope expands, update the PR title and description so reviewers can assess the final
change. Ask questions in the PR or [Discussions](https://github.com/Draculabo/AntigravityManager/discussions)
when the next step is unclear.
