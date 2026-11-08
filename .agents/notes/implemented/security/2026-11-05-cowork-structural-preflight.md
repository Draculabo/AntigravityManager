# Agent Note: Cowork structural patch preflight

Status: implemented

Scope: controlled read-only inspection and pure source previews only.

## Problem

Function-text matching classified unrelated filters, numeric returns and text examples
as patchable. It could not establish repeated variable bindings or prove that an
equal-length replacement preserved the rest of the executable payload. A syntax match
also does not establish native payload layout, installation identity or recoverability.

## Decision

The runtime owner admits bounded regular-file reads through a descriptor and checks
the selected SHA-256 before inspection. Invalid UTF-8 is unreadable. Acorn 8.15.0 is a
direct production dependency: the existing JSON parser cannot parse JavaScript and
the development compilers are not production runtime contracts.

At most 1 MiB of complete source is parsed. Only unique top-level function declarations
matching the frozen original or fixed-cutoff reverse-accumulation algorithm are
recognized. Canonicalization removes parser locations and local spelling while
preserving property names, parameter/local bindings and all algorithm structure.
Shadowed Math bindings deny admission. Nested/expression functions and arbitrary native
binary fragments remain unsupported until their owning extraction/scope contract is
verified.

Original source can produce a pure 8k preview. Its byte range uses UTF-8 offsets, the
replacement uses non-conflicting local names, padding preserves exact length, and the
result is parsed/classified again. Both hashes and unchanged outside bytes are checked.
Legacy return-zero or 35k forms cannot authorize an upgrade without version-matched
original recovery material. No disk mutation, process operation or signing is implemented.

## Alternatives considered

- Retain text regexes: rejected because strings/comments and binding drift pass them.
- Depend on a transitive Acorn installation: rejected because packaging can omit it.
- Parse arbitrary executable fragments or nested scopes: deferred until controlled native
  samples establish payload boundaries, lexical ownership and platform compatibility.
- Treat detected legacy forms as an original backup: rejected because missing original
  semantics cannot be reconstructed safely from that marker alone.

## Consequences

Unsupported inputs fail closed even when text resembles a known function. This narrows
the former permissive internal detector; there is no installed write path to migrate.
Future apply must independently recheck installation/process identity, target hash,
verified payload, backup provenance, equal-length write/readback and signing/rollback.
A preview is never evidence that those obligations passed.

## Verification

The owning source-plan and runtime tests cover frozen algorithm variants, binding drift,
text decoys, duplicates, legacy refusal, UTF-8/size admission, stale fingerprints, bundle
escape, Unicode byte preservation and controlled execution of the preview. Native
installed-client patching, code signing and recovery remain unverified.
