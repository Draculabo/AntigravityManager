# Agent Note: Streaming usage and explicit tool generation failures

Status: implemented

## Problem

The OpenAI Chat adapter ignores `stream_options.include_usage`, so clients expecting a
separate statistics block cannot consume it. Tool adapters also guess command aliases and
fabricate arguments, masking missing input. Malformed function generation can suppress the
tool continuation finish reason or hide the failure when other text is already present.

## Decision

Retain existing finish-chunk usage for default and false options. Opt-in requests receive
null usage on choice chunks and one independent statistics block after upstream completion,
including late trailers. Missing statistics remain unavailable. Unary fallback streams
preserve tools and apply the same opt-in placement without fabricating usage.

Remove the command adaptation module and its obsolete positional parameters. Preserve
ordinary tool names, parameters and function-call representation. Keep existing namespace
and custom apply-patch contracts in their current owners.

Terminate normally on malformed function generation. Explain the failure even after valid text or tool calls. Preserve valid calls and their continuation finish reasons. The upstream does
not identify the malformed tool; the diagnostic says so rather than guessing its name.
Record an upstream audit warning through the existing sanitized capture path. Do not add
automatic retries for this generation signal.

## Alternatives considered

- Suppressing all usage by default would require existing clients to change.
- Failing the entire response would discard usable tool continuation.
- A tool execution error block would falsely claim that the client executed a tool.
- Placeholder shell commands or successful workflow stubs would hide missing arguments.
- Naming the last emitted tool as failed would incorrectly blame a valid preceding call.

## Consequences

Opt-in streams wait for clean upstream end, bounded by existing timeout and idle policies.
Streams that fail after a finish frame do not emit final statistics or `[DONE]`. Default
termination remains compatible. The normal stop status means clients must read the explicit
assistant explanation or inspect the upstream diagnostic to distinguish malformed generation.
Clients that depended on guessed command aliases now receive the upstream tool contract.

## Verification

The focused protocol, mapper, usage, retry, admission, signature and real-path parity suites
pass 168 tests across 13 files. TypeScript, focused ESLint and production core compilation
pass using the installed project tools. Native runtime acceptance uses an isolated profile,
synthetic account, loopback upstream and native SQLite audit workers; all seven HTTP/SSE
cases pass with complete audit bodies and one upstream attempt per request. Reports are
kept under `artifacts/protocol-tool-compatibility-2026-10-10`.

Automatic approval initially blocked real credential use. After user authorization, the
initial live-provider checks returned 404/503 and did not validate model output. Subsequent
authorized diagnosis isolated the content HTTP User-Agent as the cause; see
[the Hub identity decision](2026-10-10-cloud-code-hub-user-agent.md). After that fix, all three
live usage and passthrough checks returned HTTP 200 with one attempt per request. Isolated
checks preserve the original configuration, shut down the owned core and remove temporary
credential copies. A later real desktop Chat probe also passes using an available 3.8 Flash
model; the unavailable 3.7 model result remains recorded separately. Controlled malformed
generation establishes gateway behavior rather than natural reproduction in a live model.
Packaging, Linux and a full client tool execution loop remain outside verification scope.
