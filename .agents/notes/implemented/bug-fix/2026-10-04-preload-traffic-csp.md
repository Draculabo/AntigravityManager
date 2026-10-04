# Agent Note: Preload traffic event parsing under CSP

Status: implemented

## Problem

Issue #334 includes a Windows 0.22.0 log with repeated preload EvalErrors. The
preload constructs Zod schemas before the page's no-eval Content Security Policy
is applied. In the existing shared renderer/preload execution environment, Zod
can cache permission to compile code during initialization, then attempt lazy
object-parser compilation after the policy forbids it. The IPC event handler throws
before delivering valid traffic updates to the renderer.

## Decision

Pass `jitless: true` to the existing traffic event schema's synchronous safeParse.
Keep the schema, invalid-event filtering, callback order, unsubscribe behavior,
window execution settings, and page security policy intact. The installed Zod
public ParseContext supports this option; no dependency or new validator is needed.

## Alternatives considered

- Allowing unsafe-eval would weaken the page policy for unrelated code.
- Changing global Zod configuration would affect more callers and require careful
  ordering before every schema module is evaluated.
- Asynchronous parsing would change callback scheduling for a synchronous event contract.

## Consequences

Traffic events use Zod's interpreted validation path with the same schema and
synchronous callback contract. Validation remains local to the event boundary.
Other preload operations and global Zod configuration are unaffected. The native
fixture guards both event delivery and enforcement of the existing page policy.

## Verification

The reusable preload-csp acceptance check builds the production preload with Forge/Vite
and launches Electron 37.10.3 on Windows using the current main-window settings.
Before the fix, the initial-policy fixture delivered zero of 100 valid events and
recorded 101 compilation errors including an invalid test event. After the fix,
initial and delayed policies both delivered the exact 100-event sequence, updated
the visible count, rejected invalid events, and unsubscribed correctly with zero
preload errors. Dynamic compilation remained blocked by the actual page policy.

The isolation/sandbox configuration initially used by the investigation did not
reproduce the problem and is not treated as evidence for the main window. The
accepted fixture reflects the production execution settings. The real Electron
checks supplement unit coverage; they do not exercise live upstream requests,
real account data, the complete Traffic Monitor page, or Linux/macOS.
