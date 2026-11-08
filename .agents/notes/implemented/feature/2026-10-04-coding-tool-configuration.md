# Agent Note: Coding Tool Configuration

Status: implemented

Claude Code, Codex, OpenCode, Hermes, OpenClaw and DSH configuration join the selected gateway owner.

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

Hermes YAML and OpenClaw JSONC operations own fields and restore only unchanged owned values.
Default activation is explicit. OpenClaw allow tokens retain unrelated additions; cleanup does
not replace a whole personal array. DSH uses the uniquely identified profile adapter, its native
version-1 credential-reference contract and native writer locks. Unknown/custom native stores
are refused rather than guessed. Preview results never contain raw client files or credentials.

Independent connection profiles keep configuration metadata in a version-1 catalog under the
selected owner's data directory. Credential snapshots use per-profile OS keyring entries.
Receipts, first backups and the pending native-write journal can contain prior secrets, so an
AES-GCM envelope protects them with a separate random key held by the same native keyring.
A missing key or invalid encrypted envelope fails closed without a plaintext fallback or reset.
The native client still receives its required credential fields; DSH receives references backed
by its native store. This does not add gateway authentication keys or a second account product.

Profile revisions guard edits and deletion. Preview hashes bind profile metadata, credential and
native-file ownership snapshots. The catalog journal distinguishes exact before and after native
bytes following interruption; unknown bytes require inspection. Native provider IDs are unique
where supported. Single-active clients require explicit activation while saved profiles remain
independent. Global selection ownership prevents one profile's removal from replacing another's
current default. Shutdown closes and drains both the profile owner and individual client owners.

## Alternatives considered

- Hand-written TOML editing requires owning TOML syntax and table placement. Rejected in favor
  of the dependency requested by the user.
- AST-assisted editing still requires a custom mutation layer. A WASM editor probe could edit
  nested tables but failed the root `model` path. Neither experimental dependency remains.
- Rewriting Codex authentication or Claude onboarding changes working business flows. Rejected.
- Redacting original backups loses exact credentials needed to restore another provider.
  Original backups remain private and owner-local instead of crossing RPC.

- Keeping all original configuration and receipts in native keyring entries exceeds native entry
  size limits. The bounded catalog therefore holds only encrypted recovery content and non-secret
  profile metadata; its encryption key stays in the existing native credential owner.
- Adding random proxy credentials would change gateway authentication. Profiles snapshot keys
  from existing owners or supported client configuration instead.
- Reusing one fixed provider ID for all profiles creates overwrite and cleanup conflicts. Distinct
  provider IDs or an explicit single-active selection slot match the actual client contract.

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
[the feature reference](../../../../docs/modules/proxy-gateway/agent-tools.md).

The new catalog admits at most 128 profiles and 1 MiB. Native keyring entries use the existing
Antigravity Manager service and profile-specific accounts. Recovery content is not portable by
copying the catalog alone. Keep the original OS-user keyring with it; never delete that keyring
as a configuration repair. Existing individual tool backups retain their own established policy.
No migration rewrites an earlier catalog or client format. Current recovery and supported-format
limits are described in the feature reference.

The 2026-11-07 client/profile implementation and independent semantic reviews are source-only.
Earlier test results above predate the changed contracts. The user explicitly deferred tests,
test edits, type checking, lint, builds, formatting, check scripts, browser validation, real
keyrings and client profiles. Native lock behavior, keyring availability, interrupted recovery,
platform permissions and real client/provider interoperability remain unverified for this snapshot.
