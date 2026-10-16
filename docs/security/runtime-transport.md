# Private Runtime Transport Security

This reference owns selected-owner bootstrap, bounded private RPC and configuration transport. Apply the global [trust model](../security.md#trust-model) to every entry.

## Selected-owner bootstrap and capture

Remote desktop bootstrap verifies core compatibility, readiness, PID, epoch and a profile
fingerprint against the profile-owner probe before enabling owner operations. The fingerprint
is identity metadata, not authentication; the existing private pipe/socket permissions remain the
access boundary. Epoch headers reject requests to replacement processes before side effects,
including OAuth and shutdown. Handshake/startup failures expose fixed errors, without paths,
credential material or arbitrary provider diagnostics. Remote startup never opens local owner
persistence as recovery.

Private remote IPC capture accepts prepared audit chunks only from the owned main-process
incremental redactor. It does not expose a raw provider-body upload API to the renderer. The core
validates epoch capabilities, canonical encoding, chunk order and size, cumulative storage and
final accounting; complete nonoversized hashes are checked against received bytes. Full oversized
hashes are trusted producer metadata because discarded suffixes are never transmitted. Capture
metadata uses the same canonical chunk validation and an aggregate retention budget. Error summaries
come from the existing owned redactor, not raw exception transport; public RPC errors retain fixed
messages. Preparing capabilities cannot run business operations, and completed input fields cannot
be rewritten. Reservations are released on retirement, including abandoned preparation. Capability
headers carry no credentials and are valid only in the current owner process. See the
[runtime topology](../architecture.md#runtime-topology) for bounds and current cutover gates.

## Configuration transport

Configuration snapshots expose bounded runtime/proxy fields and secret-presence metadata, excluding API keys and upstream proxy URLs. Explicit reveal is the only secret-bearing read; the renderer keeps its result in local interaction state rather than query caches. Secret writes use separately validated bounded input. Configuration routes are excluded from audit middleware so reveal/write payloads cannot initialize audit workers or enter admin-operation logs. Transport/service errors use value-free categories.

Only `/rpc/serviceConfig/update` and `/rpc/openCode/sync` have a 128 KiB allowance plus envelope overhead, each with a separate encoded schema bound. Other private RPC requests retain the 4 KiB limit, including secret writes with a 3,000-byte encoded bound. Desktop preferences contain no proxy credentials and use atomic versioned storage; corrupt preferences fail closed without reseeding legacy privacy consent. The existing service configuration file format and secret-storage behavior are unchanged.

## Application RPC admission and account views

Core application RPC shares the private management pipe/socket and has no TCP listener. It
accepts calls only while the standalone core is running, bounds client requests and responses,
and validates returned data. Its account-view read uses the same strict projection as the
Electron list response; the separate account-summary read remains a smaller CLI contract.
The account token, key material, proxy credentials and raw database fields never enter
either RPC response. Remote account operations propagate failures without an embedded persistence
fallback. Proxy replacement/removal is a bounded write-only core RPC operation; no RPC reads
the stored proxy URL. The repository logs only the account ID and configured/removed state,
and replaces database write failures with a value-free error so proxy credentials cannot
appear in normal logs or transport errors. Shutdown closes RPC admission before draining
requests and stopping persistence.
