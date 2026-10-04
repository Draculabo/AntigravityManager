# Agent Note: Explicit Quota Deadlines and Automatic Flash Routes

Status: implemented

## Problem

Windows Electron acceptance recorded explicit Claude quota resets exceeding 144 hours.
Text-model cooldowns truncated those deadlines to five minutes, while long image quota
evidence already survived reload. The internal transport also retried these account/model
quota failures at another endpoint. A global transient cooldown could mask a longer model
deadline, and a later transient failure could replace it.

Live standalone acceptance also found that public presets bypassed locks recorded against
their resolved physical model. Repeated Claude requests still reached both exhausted accounts
after restart even though the correct long deadline had been persisted.

The test accounts advertised `gemini-3.7-flash-tiered` with an automatic thinking budget of
`-1` and an output limit of 65536. Registered physical fallback validation rejected this
route, producing local 503 responses without an upstream attempt. Advertised Gemini 3.6
physical aliases had the same parameter-registration gap.

## Decision

Keep explicitly qualified long quota resets independently of model type. Preserve strict
HTTP status, quota-marker and reset-hint qualification. Keep inferred and transient cooldowns
capped. Use the longer active global/model wait, and never replace an active explicit quota
deadline with a shorter failure deadline. Existing success and expiry paths release locks.
Retain the existing model-availability format and compact evidence, generalized to text models.

Resolve each account's physical model when checking selection eligibility and pool wait times.
Preserve requested-model and global locks as well. Do not block an entire model family:
different physical routes keep independent deadlines.

Stop regional endpoint failover for explicit long quota failures. Normalize streamed error
bodies before deciding whether to retry, even when traffic recording is disabled. Preserve
the bounded error reader and sanitization at diagnostic boundaries.

Register the advertised automatic Flash physical aliases with complete generation parameters.
Model selection still requires the leased account to advertise the route. Unregistered future
generations remain ineligible as fallbacks. Existing fixed-tier resolution remains unchanged.

## Alternatives considered

- Capping every deadline: repeatedly schedules a model whose explicit quota has not reset.
- Preserving every 429 deadline: confuses generic resource and capacity failures with quota.
- Accepting arbitrary same-family IDs: forwards unregistered parameter combinations.
- Automatically replacing retired models: changes the requested generation without an explicit
  routing rule or user selection.

## Consequences

Explicit quota failures can remain unavailable for hours or days, matching the provider reset.
Other models on that account can still run. Reload does not discard qualified deadlines.
Provider retirement text delivered as successful content remains visible; acceptance must
require actual task completion rather than HTTP 200 alone.

## Verification

Focused regressions reproduce deadline truncation, global cooldown masking, rejected automatic
Flash selection and duplicate endpoint attempts before the fixes. The focused quota, leasing,
variant, generation-constraint and client suites include physical-route regressions for Claude
and automatic Gemini Flash: 160 tests pass across 15 files. The adapter persistence assertion waits for the public shutdown
drain because lease hydration queues persistence asynchronously. Type checking passes.

Windows standalone live acceptance checks three exhausted Claude requests, including a process
restart: all return the existing HTTP 503 pool response with a long `Retry-After`, with zero
Claude upstream attempts. The same profile's Gemini Flash control returns HTTP 200.
Packaged Electron Claude Code and OpenCode complete the Gemini Flash HTML task with matching
Traffic Monitor rows. The initial Codex Flash task exceeds the timeout while repeatedly
writing to closed shell sessions; that attempt remains a failed task. The unchanged task on
the latest package completes in 91 seconds with 11 successful requests and no tool errors.
Codex Gemini Pro completes in 71 seconds with three successful requests. A single successful
Flash repeat does not establish stable tool behavior.

Linux x64 acceptance runs through Ubuntu WSL/WSLg with an isolated profile and keyring.
The first live Claude quota failure receives one upstream 429 per account. Repeated requests,
restart, and each packaged Electron launch subsequently reject exhausted Claude locally
with HTTP 503, the qualified long deadline and zero upstream attempts. Gemini Flash remains
usable. The Forge package contains the current physical-route and quota changes; standalone
bundle hashes match its manifest, and packaged SQLite/keytar load with Electron ABI 136.

Latest Claude Code 2.1.289, Codex CLI 0.160.0 and OpenCode 1.18.34 complete eight Linux
CLI/Electron tasks: Claude Code and OpenCode use automatic Flash, and Codex uses both Gemini
Pro and Flash. All 37 parent requests complete with HTTP 200 and reported usage. All four
Electron tasks match status, token totals and details against the rendered Traffic Monitor.
Thought Store write failure deltas remain zero. Six requests recover from upstream 403;
those attempts remain visible. Linux CLI Codex Flash records two failed command executions
before completing; its captured summary does not establish their cause. The latest Electron
Flash task records no failed commands. Repeat-run tool reliability is not established.

The first Linux client installation fails during host disk exhaustion: Claude aborts at
startup and Codex lacks its optional platform dependency, with zero gateway requests.
Fresh installations of the same versions pass the matrix. A SOP diagnostic previously
misclassifies a directory containing `quota` and a stack line numbered 429 as quota errors;
it now requires an explicit error phrase, with 32 acceptance unit tests passing.
Acceptance artifacts retain those initial failures and per-build evidence. Independent
Linux workstation behavior, provider billing and successful Claude-model completion after
quota recovery remain unverified.
