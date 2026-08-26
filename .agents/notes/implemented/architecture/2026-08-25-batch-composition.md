# Agent Note: Batch execution target composition

Status: implemented

## Problem

`BatchModule` imported every protocol module to construct a `BatchExecutionTarget`. Gemini then needed the Batch runner for `batchGenerateContent`, which led to a hidden `ModuleRef.get(..., { strict: false })` lookup. The dependency direction was not visible in the Gemini constructor and made Batch ownership difficult to change safely.

## Decision

`BatchModule` owns the runner, its durable state, protocol-neutral batch operations and Batch HTTP adapters. It exports `BatchService` only.

`GeminiModule` imports `BatchModule` and injects `BatchService` for `batchGenerateContent` submission. `ProxyModule` owns a `BatchExecutionTargetBinder`; during application bootstrap it binds the existing OpenAI, Anthropic and Gemini execution methods to the Batch runner through `BatchService`.

The runner receives its target only through `BatchService.bindExecutionTarget`, which production composition calls before the application accepts requests. Focused tests use the same binding API, so lazy runner resumption continues to run against the same protocol execution methods as interactive requests.

## Alternatives considered

- Keep the global `ModuleRef` lookup. Rejected because it hides a required module dependency and bypasses declared imports.
- Use a circular `forwardRef` relationship between Batch and Gemini. Rejected because Batch would still own protocol composition and retain the reverse dependency.
- Move all Batch execution into `ProxyService`. Rejected because it would broaden the facade and make Batch lifecycle/persistence depend on a cross-protocol implementation.

## Consequences

- Batch no longer imports protocol modules merely to construct an execution target.
- Gemini has an explicit Batch dependency and no longer accesses `BatchRunnerService` directly.
- The runner remains an internal Batch implementation; composition uses the public Batch service rather than exporting the runner from `BatchModule`.
- No request, response, streaming, durable-state or environment-variable contract changes are intended.

## Verification

- `npm test -- src/tests/unit/batch-runner.test.ts src/tests/unit/gemini-batch.test.ts src/tests/unit/proxy-batch-surface-conformance.test.ts src/tests/unit/proxy-module.integration.test.ts`
- The Batch runner test proves a target bound after construction performs normal Anthropic request execution.
- The Proxy module integration test proves Nest can construct the changed dependency graph.
- A syntax-aware search confirms no `ModuleRef.get(BatchRunnerService, { strict: false })` remains.
