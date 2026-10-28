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

- The sidebar gains a `Playground` navigation item across all supported languages (en, ru, zh-CN, fr, tr, vi).
- Any client (or cURL) can target a specific account using `-H "x-antigravity-account-id: <account-id-or-email>"`.
- Requests executed through the playground naturally record in the gateway's Traffic Monitor and Thought Store.
- If the gateway is offline, a clear in-page alert banner offers a one-click button to start the service immediately.

## Verification

- `src/tests/unit/account-lease-target-account.test.ts`: 5 tests covering targeted account leasing by ID, email matching, nonexistent accounts, model mismatch, and validation blocking.
- `src/tests/unit/playground-service.test.ts`: 5 tests covering 503 gateway offline handling, successful execution metrics & header parsing, precise generation/E2E tokens/sec calculation, 429 rate limit errors, and concurrent multi-account comparison.
- `pnpm run type-check`: clean pass with zero errors.
- `pnpm exec eslint`: clean pass with zero errors.
- `pnpm exec prettier`: formatted.
- `pnpm run check:agent-contracts`: contract validation passed.
