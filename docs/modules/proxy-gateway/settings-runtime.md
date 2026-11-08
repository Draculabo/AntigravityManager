# Gateway Settings and Runtime State

This reference describes the selected owner's gateway lifecycle and configuration behavior.
Desktop-embedded and standalone Core use the same domain services through typed IPC or private RPC.

## Manual control and startup choice

The current gateway status determines whether the control offers Start or Stop. Saved `enabled`
and `auto_start` values describe a future choice and do not establish whether a listener is running.
Opening or refreshing the page does not write either value.

Manual start first starts the gateway. Only confirmed success saves both values as true, with the
actual port. Manual stop first stops it. Only confirmed success saves both values as false.
The operation and persistence results are independent. When the operation succeeds and saving
fails, the page retains its confirmed running state and offers Retry saving. This action writes
only the startup choice and never repeats start or stop. Internal startup and process shutdown do
not change the remembered choice. System-login startup remains a separate desktop preference.

## Patches and independent stores

Service updates read the latest configuration inside a bounded serialized queue. Nested proxy
objects accept field patches. Arrays and maps such as model aliases and mapping dictionaries
remain complete field values. Traffic-audit updates also require the current audit revision.
Secret changes use dedicated write/reveal contracts and never enter ordinary renderer snapshots.

Desktop preferences, service settings and account alerts have separate commits. A failed owner
does not prevent the other requested owners from saving. The settings hook retains per-owner
outcomes, rebases confirmed snapshots and preserves failed fields and edits made during a save.
Changing another owner does not automatically resubmit an older failed patch. Explicit retry
submits the retained changes. No cross-store rollback is implied.

## Saved and applied state

| Consumer | Behavior after saving |
| --- | --- |
| Gateway request configuration | The owner publishes a cloned snapshot. Per-request policy and model/prompt readers use it for later requests. |
| Gemini upstream transport | Later requests resolve the current proxy URL. Transport pool identities include the selected proxy. Existing leases retain their original transport. An invalid explicit proxy fails rather than falling back to direct access. |
| Google account HTTP requests | Each operation reads the current configuration and creates its request transport. Invalid configured proxy input propagates as a configuration failure. |
| Traffic audit | Its configure operation is attempted independently and returns its own safe failure reference. |
| Thought Store | Its configure operation is attempted independently, even if another consumer fails. |
| Error diagnostics | Its configure operation is attempted independently. Changing process storage capacity requires restarting the owning process. |
| Listener port, network policy, image account concurrency and API-key CORS presence | Startup-owned values require an explicit gateway restart. Saving does not restart the gateway. |

The service reports `applied`, `restart-required` or `partial-failure` after a successful durable
write. Failure results include the affected step and fields, a fixed reason and a diagnostic UUID.
The trusted logger retains the underlying error using the existing diagnostic redaction policy.
A failed durable write rejects before runtime application. A partial runtime failure does not
undo a completed write or automatically replay model/tool requests. Startup-owned comparisons
use the active gateway's startup snapshot, so later unrelated saves do not erase a pending restart.

## Configuration recovery

Missing, empty and whitespace-only `gui_config.json` files initialize independent validated
defaults with the proxy disabled. Snapshots expose whether initialization writeback succeeded.
An unsuccessful writeback leaves usable in-memory defaults and a diagnostic reference.

Malformed JSON, invalid fields, read failures and files above the complete 16-MiB durable
configuration bound fail explicitly. Their original bytes are preserved. A normal service save
revalidates the existing file and cannot replace a corrupt source. Migration backups precede
replacement; a required backup failure prevents the write.

Desktop startup retains account and desktop functionality when service configuration is invalid.
If no desktop-preferences file exists and legacy settings cannot be safely seeded, the desktop
uses its own defaults. An existing invalid desktop-preferences file still fails explicitly.

To recover a corrupt service file, stop its owning process, copy the original file to a separate
backup, then repair it using a known-good configuration or move it aside to request default
initialization. Restart the owner and reread settings before saving. Moving the source aside
resets service preferences and may require re-entering gateway secrets. Restore the backup with
the owner stopped if the repaired configuration is unsuitable. Ordinary page refresh is read-only.

## Admission and shutdown

Configuration writes and gateway lifecycle mutations each admit at most 32 pending operations.
The settings write budget derives from 32 management messages of at most 128 KiB. Desktop
preferences and the standalone Core lifecycle queue use the same finite admission count.
Shutdown closes entry admission and drains already accepted work before releasing profile
ownership. Gateway drain precedes service-settings drain so a successful manual operation can
finish persisting its choice. Cancellation or a lost reply does not establish rollback.

The selected owner remains pinned for the desktop session. Private Core requests retain their
owner epoch, preventing a replacement process from accepting stale operations. Stopping the
generation gateway leaves configuration, diagnostics and management RPC available.
