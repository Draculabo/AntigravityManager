# Antigravity Manager Agent Instructions

Antigravity Manager is an Electron desktop application with a React renderer and an embedded NestJS/Fastify proxy gateway. Read [docs/architecture.md](docs/architecture.md) before changing process boundaries, IPC, persistence, routing or the gateway. Use [docs/testing.md](docs/testing.md) to select verification and [docs/security.md](docs/security.md) for sensitive changes.

Instructions in a deeper `AGENTS.md` supplement this file for that subtree. Keep each rule in its narrowest owning file and link to authoritative detail instead of copying it.

## Communication

- Respond in the user's language unless they request another language.
- Keep repository artifacts, code comments, UI copy, commit messages and technical documentation in English unless the artifact is an explicit translation.
- Lead with the outcome. Report changed files, material decisions, commands actually run and remaining risk.
- Cite code with a full repository path and line number when line-level precision matters.

## Environment and tools

- Use Node.js `>=22.14.0`, npm `>=10` and the checked-in `package-lock.json`. Do not use pnpm, Yarn or Bun.
- Prefer project scripts from `package.json`; do not invent a parallel command when an owning script exists.
- The primary development shell is PowerShell on Windows. Keep scripts portable when CI or packaged behavior is cross-platform.
- When `.codegraph/` exists, use CodeGraph before text search to understand symbols and call paths. Use `ast-grep` for syntax-aware structural search, bulk refactoring, custom lint checks, vulnerability patterns and framework/API migrations.
- Bound commands with unknown output and inspect the smallest relevant context.

## Standing architecture rules

- Feature-specific UI, hooks, actions, IPC, services, persistence and types belong in `src/modules`.
- Cross-feature primitives belong in `src/shared`; generic UI belongs in `src/components`. Require a real second consumer before moving feature code into shared infrastructure.
- Renderer code must not import main-process, filesystem, database, keyring or server implementation modules. Cross-process operations go through the typed preload/IPC/ORPC surface.
- Feature modules own their IPC schemas, routers and handlers. `src/ipc/router.ts` composes them and applies global transport behavior; do not put feature business logic there.
- NestJS proxy behavior belongs under `src/modules/proxy-gateway/server`; `src/server` owns bootstrap and process lifecycle only.
- Shared database primitives live under `src/shared/persistence/database`; feature repositories and codecs remain in the owning feature.
- Routes live in `src/routes`. Never edit generated `src/routeTree.gen.ts` manually.
- Do not create reverse dependencies from `src/shared` to feature modules or deep-import another feature's private implementation.

See [src/modules/AGENTS.md](src/modules/AGENTS.md), [src/modules/proxy-gateway/AGENTS.md](src/modules/proxy-gateway/AGENTS.md) and [src/shared/persistence/AGENTS.md](src/shared/persistence/AGENTS.md) for scoped constraints.

## Type and API design

- Keep `strict` TypeScript and end-to-end domain types. Avoid `any`, broad `Record<string, unknown>` shapes and convenience casts.
- Use `unknown` only at runtime boundaries, then narrow immediately with Zod, a dedicated codec or a precise type guard.
- Validate IPC/ORPC input, configuration, persisted data, JSON, external API responses, filesystem content and process/worker messages. Trust precise same-process TypeScript contracts without redundant validation.
- Prefer discriminated unions, explicit domain types and exhaustive handling for closed variants.
- Defaults at module or protocol boundaries must be resolved explicitly by the owning implementation, not hidden deep in execution logic.
- Use named `lodash-es` imports for non-trivial collection/object transformations when they match existing project patterns; do not import the full package.

## Implementation rules

- Inspect the owning code and nearby tests before editing. Preserve existing naming, structure and error semantics.
- Make the smallest complete change. Do not add dependencies, abstractions, compatibility paths or defensive states without a current owner and demonstrated need.
- Always use braces for control flow. Keep `return`, `throw` and similar statements on their own lines.
- Comments and JSDoc explain non-obvious contracts, invariants, trade-offs and safe use. Do not restate visible control flow or keep changelog commentary in source.
- Prefer Radix primitives and Tailwind utilities for UI. Put user-visible strings in `react-i18next` resources using kebab-case keys.
- Avoid growing large modules. Prefer a new owned module for new behavior when a source file is already near 800 lines; target cohesive production modules below roughly 500 lines where practical.

## Security and data

- Never commit secrets, real credentials, authorization headers, private account data or environment files.
- Store sensitive credentials through existing OS keyring or encrypted-storage helpers. Do not write plaintext secrets to SQLite, logs, IPC payloads, fixtures or snapshots.
- Use prepared SQL or Drizzle query construction. Validate data read from SQLite before trusted use.
- Treat preload exposure, IPC, authentication, credential storage, database formats, updates, installers, binary patching and process execution as high-risk surfaces.
- Do not change database schemas, durable formats, credential location, authentication, release or deployment behavior without explicit task scope and corresponding migration/recovery evidence.

## Change workflow

1. Identify the owning module and every runtime boundary the change crosses.
2. Read the nearest instructions, current architecture reference and owning tests.
3. Inspect relevant consumers before changing a shared or public contract.
4. Implement the smallest complete slice and update its tests and current documentation together.
5. Select focused evidence from [docs/testing.md](docs/testing.md); widen only when the affected surface requires it.
6. Review the final diff for unrelated work, generated output, secrets and documentation drift.

For high-risk or difficult-to-reverse decisions, add or update an [Agent Note](.agents/notes/README.md) in the same change.

## Verification

- Focused tests are the local default. Do not run the full E2E, packaging or platform matrix for an unrelated local change.
- A behavior change needs a test or runnable check that would fail for its regression. Do not weaken assertions, skip failures or use a narrower scope merely to get green.
- Prefer equality of complete result objects or event sequences when the whole result is the behavior under test.
- Do not add tests for removed behavior, statically fixed values or impossible hostile inputs at typed same-process boundaries.
- Run `npm run check:agent-contracts` for changes to agent instructions, governance documentation, Agent Notes or project Skills.
- Run `npm run type-check` when shared types, public exports, IPC contracts or module boundaries change.
- Report environment-dependent evidence such as native keyring, Electron packaging, installer and live-provider checks as unverified when it cannot run.

## Documentation and decisions

- Follow [docs/AGENTS.md](docs/AGENTS.md) for documentation placement and writing rules.
- Current behavior belongs in architecture, testing, security, development or feature references. Rationale and rejected alternatives belong in Agent Notes.
- Update README/JSDoc and affected reference docs in the same change as their behavior. Do not rely on a future plan document as authority for shipped behavior.
- Keep Markdown links relative and specify a language for every fenced code block.

## Worktree and Git safety

- Treat existing tracked and untracked changes as user-owned. Do not modify, delete, stage or format unrelated files.
- Do not commit, push, rewrite history, publish or deploy unless the user explicitly asks.
- Never discard work with destructive Git or filesystem commands without explicit authorization and a verified target.
