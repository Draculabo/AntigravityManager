# Development

This document covers contributor setup and routine commands. Command definitions in [package.json](../package.json) are authoritative; update this document when their purpose or required environment changes.

## Prerequisites

- Node.js `>=22.14.0`.
- npm `>=10`.
- A supported Electron development environment for the target operating system.
- Native build prerequisites when rebuilding `better-sqlite3`, keyring packages or Electron-native modules.

Use npm only. The repository contains `package-lock.json`; do not introduce another package manager or lockfile.

## Common commands

```powershell
npm install
npm start
npm run type-check
npm run lint
npm run format
npm test
npm run test:e2e
npm run package
npm run make
```

- `npm start` starts Electron Forge with Vite in development mode.
- `npm test` runs the Vitest unit and integration suite once.
- `npm run test:e2e` runs Playwright against the Electron application.
- `npm run package` creates an unpacked application bundle.
- `npm run make` creates platform distributables and is slower and more environment-sensitive than packaging.

Run one unit test with:

```powershell
npm test -- src/tests/unit/example.test.ts
```

Run one E2E test with:

```powershell
npm run test:e2e -- src/tests/e2e/app.spec.ts
```

Use [testing.md](testing.md) to select checks according to the affected behavior. Do not run packaging, the complete E2E suite or every local check by reflex when a narrower test proves the changed path.

## Change workflow

1. Inspect the owning module, nearby tests and the nearest `AGENTS.md` before editing.
2. Identify whether the change crosses renderer, preload, IPC, main, server, persistence or external protocol boundaries.
3. Make the smallest complete change and preserve unrelated worktree changes.
4. Run focused evidence first, then add broader checks only for affected surfaces.
5. Report the commands actually run and any platform, credential or environment coverage that remains unverified.

## Generated and derived files

- Do not edit `src/routeTree.gen.ts` manually.
- Do not commit generated application packages, installers, coverage output or local performance recordings unless a repository workflow explicitly owns them.
- Generated assets must be recreated through the owning script and reviewed with their source inputs.

## Desktop diagnostics

Development logs from Electron main and the embedded NestJS gateway appear in the main-process console. Renderer logs and React diagnostics appear in Chromium DevTools. `Shift + Click` can jump from a rendered element to source when `code-inspector-plugin` is enabled.

Sentry is enabled only when the relevant build configuration and credentials are present. Absence of Sentry in a local build is not evidence that the instrumentation path is broken.

Performance recording and local update-feed helpers live in `scripts/` and have dedicated npm commands. Use them only when the task concerns those paths; some operations create local artifacts or require platform-specific binaries.

## Environment failures

When a required command fails because of sandbox, credential, native-module, GUI or network restrictions, preserve the original command and capture the concrete failure. Retry with the narrowest permitted environment change only after the failure identifies that boundary. Do not reinterpret a genuine test failure as an environment problem.
