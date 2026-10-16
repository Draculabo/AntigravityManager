# Gateway Storage and External Input Security

This reference owns audit/Thought retention, content capabilities, coding-tool files and local media access. The [global security reference](../../security.md) owns trust and validation rules.

## OpenCode account configuration

OpenCode refresh grants remain inside the selected owner and its existing external plugin account file; this integration does not introduce a Manager-side token-refresh mechanism. Normal responses contain strict status, intentional current configuration location metadata or a bounded redacted preview. Backup contents, backup/temporary locations, OAuth grants and dedicated keys do not cross control transport. OpenCode renderer routes bypass audit middleware. Configuration, local-account and OpenCode public errors preserve only validated closed categories and fixed messages; their IPC error logs omit raw input, values, causes and stacks. External plugin formats, account selection, backup recovery and native dedicated-key storage remain unchanged.

## Audit file export

Audit file export keeps body contents and destination paths outside renderer responses. Only the trusted desktop chooser supplies a bounded absolute destination; private input is independently bounded to 3,000 encoded bytes. The selected owner enforces the existing 100 MiB body ceiling while streaming, uses a new sibling temporary file with restrictive POSIX permissions and preserves the prior destination on failure before replacement. Parent-directory synchronization errors after replacement indicate uncertain durability rather than rollback. Export failures expose fixed text without filesystem/provider diagnostics. The desktop retains its creating adapter throughout selection and does not use embedded persistence on remote failure.

## Proxy traffic and thought persistence

Selected-owner audit management responses are validated and bounded below the ordinary control
response cap. Escaped body pages retain only complete chunks and continue from the first deferred
chunk. Owner admission/drain covers reads and mutations; transport failures never invoke local
fallbacks. Presentation journals retain at most 128 reference events and return at most 32 per
batch, without bodies or worker errors. Public audit IPC failures omit raw input, causes and
stacks. Repair retains the existing intentional backup-location result; this does not authorize
reading that backup through control RPC.

Explicit Thought/cURL content uses purpose- and resource-bound owner capabilities with epoch,
UUID, expiry and sequential byte cursors. Each content owner permits four snapshots and 256 MiB
of retained body buffers. Each chunk is at most 64 KiB before base64 encoding; normal control
limits remain unchanged. Completion, explicit close, expiry and owner drain release retention.
Disconnect cleanup is best-effort and diagnosed without values; expiry bounds orphan retention.
Thought detail intentionally returns plaintext thought, visible text and nullable signature to
the requesting renderer. Their combined body has a 256 MiB operational transfer ceiling while
thought text retains its 64 MiB limit. cURL capabilities and commands stay in Electron main;
only copied status reaches React. The 8 MiB replay-body limit remains separate from the 64 MiB
quoted-command ceiling. Current gateway key inclusion remains opt-in; upstream credentials
remain prohibited. Public Thought/cURL errors omit raw inputs, contents, causes and stacks.

Traffic audit and Thought Store data live in separate SQLite databases under the proxy state
directory and are written by separate bounded worker threads. The model path is fail-open: queue
overflow, worker failure and shutdown-drain timeout are reported as counters but do not alter the
provider response. Read-only audit/Thought management calls are not recursively audited. Clear,
delete, repair and setting changes produce metadata-only admin events.

Before an audit payload reaches SQLite, authorization and cookie headers, credential-bearing query
parameters, and recursively matched JSON credential keys are replaced with `[REDACTED]`. Media
bodies retain metadata and a SHA-256 digest, not bytes. Free-form prompt, code and tool output is
not heuristically scanned; users who place credentials in ordinary content are choosing to retain
that content in plaintext. Thought text and signatures are also plaintext by explicit product
policy. The UI automatically previews stored bodies up to 20 KiB. Larger bodies show a 20 KiB
prefix until the user chooses to browse more; signatures remain collapsed until expanded.

The Traffic Monitor's cURL export is an explicit local clipboard exception, not an audit-storage
exception. Its credential switch starts off for each page visit and resets on filter changes. When selected, the main process
substitutes the **current** local proxy API key into a parent-request command and writes it directly
to the OS clipboard; the renderer and IPC response never receive the key. Historical credentials
cannot be reconstructed from redacted records. Upstream-attempt export is always redacted. The
clipboard may be read by other local applications and the pasted command may disclose its key;
users should treat it as a secret and clear it when finished. Export refuses partial, expired,
binary or oversized request bodies rather than silently generating an incomplete replay.

Audit parent and attempt tables contain metadata and references, never large inline body columns.
Sanitized body content is written in 64 KiB chunks with a 100 MiB stored-prefix ceiling per unique
logical payload. Exact payloads may share a reference only inside the same parent request; there is
no cross-request content-addressed ownership or reference-count lifecycle. Normal SSE stores a
reconstructed response and preserves unrecognized events. Parse failures store redacted raw SSE,
framing and error location, not byte-identical upstream content. Authenticated body reads are paged
by default; the full-content route streams chunks and the renderer requires explicit confirmation
before accumulating a complete body for clipboard copy.

Both databases reject unknown future schema versions. Corruption does not trigger automatic
replacement. An authenticated explicit repair first closes the worker, then preserves the main
database and WAL/SHM sidecars under a timestamped `.corrupt-*` name before creating a fresh file.
For this unshipped audit feature, an older audit schema is archived with its WAL/SHM sidecars and
replaced by an empty schema v4 database. No old audit rows are migrated; the independent Thought
Store database is untouched.

## Coding tool configuration files

Claude Code and Codex settings store the existing gateway API key in the client-readable format
required by each client. Their first `.antigravity-manager.bak` recovery file preserves the exact
original text and may contain credentials from a previous provider. These are explicit local
interoperability files, not Manager account-database migrations. Files use mode `0600` where
supported; Windows access follows the containing profile's ACL. Do not share, log or commit
these files. Backups and arbitrary client settings never cross the control transport; previews
project only model/address fields and a hidden credential marker. The user confirms complete
restore in the UI or supplies CLI `--yes`. See
[agent-tools reference](agent-tools.md) for the difference between removal
and restoration.

## Local video paths

OpenAI Chat Completions local `video_url` paths are disabled by default. The user can enable
`proxy.experimental.allow_local_video_paths` in Settings; the running gateway reads this setting
for every request, so no restart is required. Once enabled, the existing proxy API-key boundary is
the only caller restriction and there is no directory allowlist: any authorized proxy client can
request any regular file readable by the desktop process. The Settings description must keep this
scope explicit. While the setting is disabled, `video_url` handling must not probe or read the local
filesystem; explicit local path forms are rejected lexically and ambiguous non-URL strings retain
the gateway's raw-Base64 fallback.
