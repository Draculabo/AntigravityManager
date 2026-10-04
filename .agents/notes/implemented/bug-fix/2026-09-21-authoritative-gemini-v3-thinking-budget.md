# Agent Note: Authoritative Gemini 3 thinking budgets

Status: implemented

## Problem

The variant selector previously consumed raw native Gemini `thinkingBudget` and OpenAI-compatible `thinking.budget_tokens` before generation constraints were applied. A request for an explicit or default Gemini 3 high-tier model could therefore be routed to a low-tier physical variant. Later generation constraints only made the already selected low variant internally consistent; they could not restore the requested server-owned profile.

## Decision

Known Gemini 3 variant families, Gemini agent identifiers, numeric Gemini 3+ identifiers, and explicit `-high`/`-medium`/`-low`/`-extra-low` tiers now remove raw native thinking controls before variant selection. The OpenAI-compatible surface removes its raw `thinking.budget_tokens` and `thinking.effort` controls while preserving the explicit `reasoning_effort` tier selector.

The same authority rule reaches direct/pass-through Gemini identities that do not have a registered variant profile. Before sending upstream, generation constraints inject the account capability's thinking budget (or the static model specification fallback), so a direct `gemini-pro-agent` request cannot retain a client-supplied lower budget. Direct agent model specifications provide the corresponding fallback output and thinking limits.

The same policy now reaches the Anthropic Messages path. For an authoritative Gemini 3 or explicit-tier request, `thinking.budget_tokens` is removed before model-variant resolution, while the documented Anthropic `output_config.effort` remains the permitted tier selector for a bare canonical model. Explicit model suffixes take absolute precedence over either effort or a raw budget. Direct Gemini agent requests also carry the authority decision to final generation-constraint injection, so their upstream body cannot retain a lower client budget.

## Alternatives considered

**Clamp only after variant selection.** Rejected because a low physical variant has already been selected by that point, so clamping cannot recover the original high-tier route.

**Ignore every client thinking control on every protocol.** Rejected because it would silently remove the documented OpenAI `reasoning_effort` and Anthropic `output_config.effort` selectors. The authoritative rule suppresses raw budgets, while retaining these protocol-specific explicit effort controls for bare canonical models.

## Consequences

Raw budget and native level inputs no longer downshift registered Gemini 3 models or leak through direct Gemini 3+ and agent identities. Anthropic raw budgets now receive the same treatment. This preserves the upstream profile's expected thinking configuration and avoids accidental low-budget routes. Callers that need an OpenAI-compatible tier selection continue to use `reasoning_effort`; bare Anthropic canonical-model callers can use `output_config.effort`.

## Verification

The focused model-variant policy suite verifies registered Gemini 3 profiles, direct `gemini-pro-agent` native and OpenAI paths, unregistered generation-constraint injection, and preservation of `reasoning_effort`. Type checking, targeted formatting/linting, Agent-contract validation, and a whitespace diff check are run with this change.
