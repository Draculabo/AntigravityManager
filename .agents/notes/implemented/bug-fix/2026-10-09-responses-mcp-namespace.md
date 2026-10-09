# Agent Note: Restore declared MCP namespaces in Responses calls

Status: implemented

## Problem

Codex declares the controlled MCP tool as `read_probe` inside namespace `mcp__probe`.
The gateway flattens it to `mcp__probe__read_probe` for the upstream declaration. Output
restoration previously treated every `mcp__` name as a legacy flat tool. Codex therefore
receives the wrong function name without a namespace and returns `unsupported call`.
Its final response does not contain the actual probe result, despite successful upstream HTTP
responses. Namespaced call history also loses its namespace at the Responses input boundary.

## Decision

Use the request's tool declarations to restore the original function name and namespace.
Retain existing treatment of flat MCP declarations. Pass the same declarations through
streaming, unary, project fallback and synthetic stream paths. Validate optional namespace
fields on function/custom call input and qualify names when rebuilding upstream history.
Synthetic streams requalify previously restored calls before mapper emission.

No durable format, account policy, signature policy or Schema budget changes are required.
The temporary client harness guards fixed probe access and never simulates successful provider
answers. Native Windows Shell execution-policy failures remain independent failed evidence.

## Alternatives considered

- Splitting every MCP name breaks clients that declare the full legacy name without a namespace.
- Changing the test client's declared function or mocking a tool result conceals the production bug.
- Changing global client permissions does not repair the protocol contract and exceeds this scope.

## Consequences

Restoration depends on request-owned declarations rather than the lexical `mcp__` prefix alone.
The mapper retains current call identifiers and event ordering. No migration is needed.
Nested namespace handling retains the existing flattening rules; this fix proves the observed
single namespace MCP case, not arbitrary namespace collisions or every client configuration.

## Verification

The initial focused run reproduces three failures: declaration restoration and both streaming
and unary real request paths. Regression coverage checks original output name/namespace and
qualified continuation names, while existing flat-MCP tests remain intact. Executed checks and
real default-upstream results are recorded in the
[client verification record](../../../../artifacts/schema-work-package/client-matrix-verification-2026-10-09.md).
