# Agent Note: Coding Tool Configuration

Status: implemented

Claude Code and Codex configuration joins the selected gateway owner.

## Problem

OpenCode configuration exists, but Claude and Codex require manually maintained client settings.
The desktop and standalone core must own the same operations without exposing connection keys
or replacing existing client login and permission settings.

## Decision

The proxy feature owns Claude/Codex codecs, serialized file operations and typed RPC. The CLI
owns terminal commands. A shared card frame displays saved configuration separately from live
verification. Existing JSONC editing handles Claude; the maintained `smol-toml` dependency owns
Codex parsing and serialization. Original file text is backed up before writing and retained for
an exact full restore. Removal restores only owned fields, preserving unrelated later edits.

Codex uses a custom Responses provider with static authorization headers and leaves `auth.json`
alone. Its hard-coded automatic-review model requires an additive gateway route. Explicit routes
are preserved; a disabled route fails setup. Shutdown drains admitted tool work before closing
the configuration queue needed by that route.

## Alternatives considered

- Hand-written TOML editing requires owning TOML syntax and table placement. Rejected in favor
  of the dependency requested by the user.
- AST-assisted editing still requires a custom mutation layer. A WASM editor probe could edit
  nested tables but failed the root `model` path. Neither experimental dependency remains.
- Rewriting Codex authentication or Claude onboarding changes working business flows. Rejected.
- Redacting original backups loses exact credentials needed to restore another provider.
  Original backups remain private and owner-local instead of crossing RPC.

## Consequences

Codex formatting changes and comments disappear during edits; complete restore recovers their
original text. Backup policy and user confirmation make this trade-off visible. Local client
settings and backups can contain credentials and must stay private. Routing and client writes
are separate durable operations, so an additive route may remain after a failed client write or
client restore. Installation detection and saved settings do not certify live requests.

## Verification

Owning file tests exercise JSONC/TOML edits, invalid-file rejection, exact restore, owned-field
removal, backup/write failures, RPC secret projection and configuration-path overrides. CLI,
component, selected-owner and configuration-queue tests cover the runtime contracts. Build and
live client evidence are recorded separately; no mocked test is treated as upstream acceptance.
Current operations and risks are documented in
[the feature reference](../../../../docs/coding-tool-configuration.md).
