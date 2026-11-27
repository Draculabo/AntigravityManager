# Agent Note: Antigravity CLI local sign-in ownership

Status: implemented

## Problem

Users can sign in to `agy` outside Manager. The local import preview needs to discover that sign-in,
and the CLI badge needs to reflect the corresponding managed account. Modern CLI logins can use
the system credential store that desktop clients also use.

## Decision

The runtime exposes a read of the dedicated `agy` sign-in file in the selected owner's operating
system environment. Local account import adds that file as a source and uses the existing preview,
validation, deduplication and confirmation pipeline. Renderer and Core transport carry the source
ID and preview data. The file path and credentials stay with the owner.

List projection matches the file's refresh token only to managed Google accounts. It shows the CLI
badge for a unique match, suppresses an outdated badge when a usable credential has no unique match,
and uses the saved Manager selection when no readable credential can be attributed to the CLI.
After observing a live CLI login without the dedicated file, retain the system keyring as the
existing shared import source. Allow it to determine the badge when the CLI is installed and
installed desktop clients do not use the store. The badge probe uses the actual system store and
excludes the macOS file fallback. The read does not mutate the saved selection, start the CLI or
change the existing list refresh schedule.

Windows `agy` switches use the same exact Windows credential target and Agent identity envelope
as the IDE. The runtime updates the existing CLI files first and requires native write and exact
readback before account finalization. Current-account and snapshot reads use that native item
when present. The dedicated file remains a separate import source.

## Alternatives considered

- Unconditionally preferring shared Keyring or generic Gemini OAuth credentials would let an
  unrelated desktop login determine CLI status.
- Matching on an email hint would make the unverified hint authoritative.
- Persisting observed status would turn a read into a mutation and could overwrite a concurrent
  switch. Projection needs only the observed match.
- Windows file-only switches can report success even though a new CLI process authenticates from
  an older system credential. Existing client logs record successful authentication via keyring.

## Consequences

The new source expands the strict local import preview contract. Desktop and Core use owner
compatibility `13` and upgrade together. Existing import sources and saved account data continue
to use their current formats. The badge reflects the saved CLI credential at refresh time and
does not guarantee that an already-running CLI process has reloaded it.

The Windows account is shared with clients that use `gemini:antigravity`. Manager serializes its
own switches. Other processes can refresh or replace the item independently. An unsuccessful
write triggers verified compensation for the application's own values, using in-memory snapshots
of the prior bytes and native metadata. An observed external change is left in place and is
reported as unconfirmed recovery. Keeping the snapshots in memory avoids a new durable copy of
login credentials. The Windows and filesystem APIs do not provide a shared compare-and-swap,
so recovery checks cannot exclude an external write racing the restore itself. Existing sessions
should be closed before switching or retrying.

## Verification

- The local discovery and list suites cover isolated file discovery, deduplication, unique and
  ambiguous matches, unmatched accounts and failed reads.
- The Core RPC test checks the new preview source across a real local endpoint. Live client sign-in
  remains separate from the automated fixtures.
- List regression fixtures exercise a system-keyring login with only the CLI using it, a shared
  store with each desktop target and a newer credential that does not match the saved selection.
- The Windows account-write fixture exercises repeated CLI switches against a temporary native
  item. Unit checks cover a rejected native write and a stale native readback. These checks
  establish stored credentials. Fresh CLI authentication is a separate live check.
