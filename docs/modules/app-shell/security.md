# Desktop Presentation and Update Security

This reference owns preload validation, error-detail exports and update presentation. Global restrictions remain in [Security](../../security.md); shared reporter contracts are in [Diagnostic privacy](../../security/diagnostics.md).

## Preload traffic validation

Traffic events received by the preload are synchronously validated with Zod's per-parse
`jitless` option before reaching renderer callbacks. Zod can initialize before the page's
Content Security Policy takes effect; a cached permission to compile JavaScript must not
cause later event parsing to attempt dynamic compilation. The page keeps its existing
no-eval policy, and invalid events do not reach subscribers. This option is local to the
preload event boundary and does not change Zod configuration in other processes.

## Error details and report exports

Error notifications and cloud-account load failures offer an explicit bug-report action. It copies the complete
checked-in GitHub bug template, filling the app, OS, architecture, Electron and Node versions and
the available error details in their template sections, then opens
the GitHub bug template without report contents in its URL. The environment endpoint excludes
hostname, network addresses and account identifiers. The report masks common credential forms,
email addresses and user-directory names; copying the report does not read account records or log files. Users
paste the complete report into the issue body, complete the description and reproduction steps,
and submit it themselves. The diagnostic block retains the operation UUID and, when captured,
the Sentry event ID. Neither an SDK receipt nor opening the template proves remote delivery.
Clipboard failure prevents opening the form; browser
failure preserves the copied report and provides the form URL for manual continuation.

Notification callers pass the caught exception to the renderer's toast boundary, which immediately
extracts the available stack and diagnostic fields and applies the existing redactor. Notification
state retains this text snapshot, never the raw exception or arbitrary provider/account properties.
Google-login and cloud-switch errors retain their validated feature category and
[correlated diagnostic](../../security/diagnostics.md#correlated-operation-reports) across public IPC. These details use the
safe summary instead of raw backend or renderer transport stacks.
The details dialog renders that same snapshot as selectable plain text and remains closable during
report preparation. A backend stack removed by its owner
cannot be reconstructed from the renderer's transport stack. Missing exceptions use the available
notification text without creating a synthetic stack. Viewing details does not copy or send a report.

The error details dialog offers an optional sanitized log attachment. Generation reads the ten
minutes ending at its captured start time from rotating `app` logs and, in standalone mode, the
selected core's rotating `core` logs. Core sanitization runs inside that owner; unavailable core
logs never fall back to local core files. The reader excludes audit databases, request captures,
account backups and symlinks. File selection, read work, retained previews and output are bounded;
each source contributes at most 448 KiB and the complete UTF-8 attachment remains below 1 MiB.
Missing sources and truncation appear in both preview and attachment.

Uncertain records lose their entire free-text content, including prompts, tool arguments,
request/response bodies, stacks, identities, paths and credentials. Only timestamps, levels,
closed error codes, bounded HTTP statuses/timing/retry fields and specific Boolean diagnostics
survive. Versioned `Operation diagnostic v1` and `Operation step v1` records also retain their
validated closed fields and UUID; unknown fields and continuations invalidate the complete record.
A UUID in an arbitrary message does not authorize its contents. A small set of exact fixed diagnostic messages can survive unchanged. Removed records
are marked `Content removed`; arbitrary message prefixes, nested objects and string values are
never preserved. This intentionally favors privacy over completeness.

Only sanitized text crosses IPC. Electron main retains at most four expiring preview snapshots;
the save endpoint accepts their UUID capabilities, never renderer-provided contents or paths.
The trusted save dialog supplies the destination, and atomic export writes exactly the reviewed
snapshot with restrictive POSIX permissions. Export rejects non-text destinations and the profile
directory, protecting original logs and backups. Attachment routes bypass traffic auditing.
Users preview, save and manually attach the file to GitHub. Generation or save failure leaves
error-only reporting available and never substitutes original logs or uploads anything.

## Update delivery and release-note rendering

Windows automatic updates use separate Squirrel and NSIS feeds. Only a recognized installed
package activates its matching updater; MSI and unpacked builds cannot invoke either automatic
installer. The release feed generator verifies the NSIS installer's size and SHA-512 against its
metadata before publishing a feed that points to the release asset. The updater does not disable
the library's installer verification. A local-feed override is used only when the explicit
unmanaged-test flag is also set; ordinary installed builds use the configured release feed.

Linux automatic installation is limited to the original absolute, non-symlink AppImage path
with writable file and parent directory. The app checks the type-2 AppImage header and matching
x64 or ARM64 ELF machine before activating the updater and again on the downloaded archive.
The library verifies SHA-512 before the archive is offered for installation; readiness also
rechecks the cached file and original target. DEB/RPM installation and permission elevation
are outside this path. The generic feed uses the repository's GitHub release assets, and a
local URL requires the same explicit unmanaged-test flag. Release transport and metadata are
trusted together: the checksum detects corruption, but is not an independent signing identity.

Release-note requests accept a bounded semantic-version tag, not a renderer-provided retrieval
URL. The app-shell owner constructs repository-specific metadata/API URLs, bounds HTTP responses
to 2 MiB and descriptions to 262,144 characters, and applies a 20-second overall deadline with
renderer cancellation. Response schemas and target-version checks run before descriptions reach
the typed ORPC result; retrieval errors expose a fixed status rather than provider diagnostics.
Release Markdown does not execute raw HTML or load images. Image descriptions and addresses,
and links outside the navigation allowance, remain text. A separate main-process operation opens
only HTTPS pages in this GitHub repository or GitHub profile-shaped destinations, excluding
reserved site routes and credential-bearing URLs. This operation does not expand the existing
general external-link allowlist.
