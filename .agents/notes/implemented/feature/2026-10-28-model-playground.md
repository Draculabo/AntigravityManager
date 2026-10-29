# Agent Note: Interactive Model Playground for multi-account testing

Status: implemented

## Problem

Antigravity Manager users manage multiple cloud accounts with differing quotas, model support and rate limits. Currently, verifying whether a model works on a specific account or inspecting output quality, thinking tokens and response latency requires configuring external CLI tools, cURL commands or third-party desktop clients (such as OpenCode or Cherry Studio). The application provided only static cURL/Python text snippets on the API Proxy tab, leaving users without any in-app way to test completions or diagnose account failures.

## Decision

Introduce an in-app **Model Playground** accessible via the `/playground` route in the sidebar (`FlaskConical` icon) with two testing modes:

1. **Single Account Mode**:
   - The user selects a target account (or "Auto Pool"), a model, and enters a prompt (with quick preset buttons: Hello, Reasoning, Identity, Code).
   - Collapsible advanced parameters allow configuring an optional system prompt, temperature, and max output tokens.
   - The execution is handled via a dedicated typed IPC route `ipc.client.gateway.playground.execute`, which invokes the running gateway's OpenAI-compatible completions endpoint.
   - The response card displays status, latency, time-to-first-token (TTFT), generation tokens/sec, E2E tokens/sec, token usage, the exact account that served the completion, thinking/thought process disclosure (for reasoning models), and copy buttons (response text and reproducible cURL).

2. **Multi-Account Comparison Mode**:
   - The user can select multiple accounts (or "Select All") and run a single prompt across all of them in parallel.
   - Displays side-by-side comparative cards showing response content, HTTP status, latency and token metrics, making it easy to identify rate-limited accounts vs healthy ones.

3. **Account Model Benchmark Mode**:
   - The user selects a target account and chooses which advertised/catalog models to probe.
   - Sequentially sends probe requests across all checked models with randomized jitter delays (e.g. 500ms–1200ms) to prevent provider rate-limit spikes and burst throttling.
   - Live progress indicator and stop control to safely halt an in-flight batch.
   - Metrics table rendering status, TTFT, pure generation speed (tokens/sec = `completion_tokens / (total_duration - TTFT)`), E2E throughput (tokens/sec = `completion_tokens / total_duration`), total latency, and token breakdown.
   - Summary cards displaying total tested/passed/failed, average TTFT, average generation speed, fastest model by throughput, and fastest model by TTFT, with one-click export of the results as a Markdown table.

4. **Gateway Targeted Account Routing**:
   - Support `x-antigravity-account-id` (and `x-account-id`) in `AccountLeaseService.getNextToken({ targetAccountId })` and `ProxyRetryService.selectRetryToken`.
   - The proxy gateway directly leases and hydrates the targeted account (by account ID or case-insensitive email), verifying model capability and validation status without falling back to other accounts.
   - Proxy response headers emit `x-antigravity-account-id` and `x-antigravity-account-email` for diagnostic transparency.

## Alternatives considered

- **Embedding in the API Proxy tab as an extra tab**: Keeps the sidebar smaller, but crowds the proxy service controls and limits space for side-by-side multi-account comparison. A dedicated top-level route gives full screen real estate for viewing prompts, reasoning blocks and comparative results.
- **Direct browser `fetch` from the renderer**: Browser `fetch` would be subject to CORS restrictions in environments where `api_key` is not configured (`app.enableCors()` is only called when an API key is configured). Routing through typed IPC (`playground.router.ts`) is secure, avoids leaking secrets to renderer storage, and ensures consistent error handling.

## Consequences

Playground operations follow the gateway's selected runtime owner rather than reading Electron's
embedded NestJS state in every mode. Standalone execution uses private core RPC, with schemas
at both process boundaries and cancellation forwarded to the owner HTTP request. The core retains
its API key and configured request timeout, rejects new work during shutdown and drains admitted
generation before releasing ownership. Reusing the existing adapter and core admission/drain
mechanism avoids a second gateway-selection policy. An unavailable core remains an error; there
is no embedded fallback. Request limits are scoped to the two Playground RPC routes so long
UTF-8 prompts do not widen unrelated management methods.

- Targeting overrides account choice, not account eligibility: exclusions, cooldowns, model limits
  and depleted quota remain enforced. Image scheduling waits for the pinned account's capacity.
- Dual and benchmark runs own an AbortController. Stop and unmount abort the IPC/HTTP call; each
  completion also checks run identity so a cancelled response cannot replace a later result.
  Provider work already accepted may still consume quota; cancellation does not promise rollback.
- Execution and cURL export share the request builder. Results retain the submitted parameters,
  not current form values, and exports use a credential placeholder.
- Gateway startup reuses the existing risk-confirmation UI. Domain start failures do not produce
  a success notification. Invalid completion payloads produce a 502 result.

- The sidebar gains a `Playground` navigation item across all supported languages (en, ru, zh-CN, fr, tr, vi).
- Any client (or cURL) can target a specific account using `-H "x-antigravity-account-id: <account-id-or-email>"`.
- Requests executed through the playground naturally record in the gateway's Traffic Monitor and Thought Store.
- If the gateway is offline, a clear in-page alert banner offers a one-click button to start the service immediately.

## Verification

- `src/tests/unit/account-lease-target-account.test.ts`: targeted account eligibility, email matching and validation blocking.
- `src/tests/unit/playground-service.test.ts`: offline handling, response validation, metric calculation, cancellation, 429 errors and comparison.
- `src/tests/unit/gateway-adapter.test.ts`: selected-owner execution, long UTF-8 comparisons and no embedded fallback.
- `src/tests/unit/core-rpc.test.ts`: private transport cancellation and byte-limit rejection.
- `src/tests/unit/playground-owner-lifecycle.test.ts`: shutdown admission and draining.
- `src/tests/unit/playground-ui.test.ts`: comparison selection and request lifecycle behavior.
- `src/tests/performance/playground-workspace.spec.mts`: isolated Electron coverage of initial model selection, empty initial account selection, select-all beyond ten accounts, partial failures, cancellation, retry and desktop themes with synthetic IPC data.
- `pnpm run type-check`: clean pass with zero errors.
- `pnpm exec eslint`: clean pass with zero errors.
- `pnpm exec prettier`: formatted.
- `pnpm run check:agent-contracts`: contract validation passed.
