# Agent Note: SQLite worker exit and ASAR duplicates

Status: implemented

## Problem

The bundled Node 24 runtime can unload the legacy SQLite add-on while V8 still holds its cleanup
callbacks. On Windows the isolated Thought Store worker acknowledged shutdown, then crashed the
process as the worker was terminated. The same desktop build also shipped 14 copies of one
OpenTelemetry semantic-conventions version in its ASAR.

## Decision

Use the Node-API release of `better-sqlite3` for the desktop and standalone runtime. Prepare the
standalone tree with only the SQLite prebuild for its target. Keep the existing worker shutdown
contract and verify it through the shipped worker entry. The bundled official Node distribution is
the glibc build on Linux.

Resolve `@opentelemetry/semantic-conventions` to a single version supported by the installed
consumers. Enforce the resolution in the lockfile so clean installs and production-only installs
follow the same rule.

## Alternatives considered

- Preloading SQLite in the parent process masks the lifetime failure by keeping the add-on mapped.
  A delay before termination also changed the failure rate. Both approaches leave cleanup dependent
  on process composition or timing.
- Deleting nested dependency directories after packaging would couple the package step to one
  installation layout and could change module resolution. The dependency resolver owns the layout.

## Consequences

The supported desktop and standalone targets consume a published SQLite binary. The lockfile
override leaves other OpenTelemetry packages at their existing versions. A future change to the
override must check its consumers' ranges and the physical package layout.

Linux RPM builds run the target runner's `strip` against staged ELF binaries. The SQLite npm
package carries both x64 and ARM64 prebuilds, so the desktop copy retains only the target glibc
binary before making installers. The dependency installation remains available to other targets.

## Verification

The [delivery procedure](../../../../docs/testing/delivery.md#native-installed-runtime) covers
standalone worker termination. Check the emitted Windows ASAR for a single semantic-conventions
directory and use the existing package size budget to identify remaining growth.
The desktop staging regression covers both Linux architectures and rejects a missing glibc
prebuild. Native RPM verification requires building both packages and opening SQLite from each
installed desktop payload.
