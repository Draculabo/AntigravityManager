# Agent Note: Global system prompt compatibility

Status: implemented

## Problem

A gateway-wide system prompt needs a separate configuration field and a predictable position relative to identity and caller instructions. Native Gemini requests must avoid duplicate injection, and saved changes must reach subsequent requests even when the gateway is stopped.

## Decision

Use a backward-compatible, default-disabled `proxy.global_system_prompt` configuration with `enabled` and `content` fields. Resolve it through the already-hot `server-config` owner. Each OpenAI/Anthropic system mapper and native Gemini envelope prepends one dedicated global section before caller instructions. Preserve configured whitespace and all caller repetitions. Trim only to detect an entirely empty setting. Matching text, quotations or section tags in caller data do not establish gateway provenance and cannot suppress injection.

The existing config save handler already synchronizes `server-config` without requiring a running gateway, so the new field uses that established hot-update boundary rather than creating a second in-memory store.

## Alternatives considered

- Omitting the configuration field would leave users unable to apply a gateway-wide instruction consistently across protocols.
- Appending raw text to an already rendered instruction would make an identity-like custom prompt bypass the structured instruction layout. A dedicated section preserves identity, spacing, and ordering.
- Applying the prompt to user messages or tool payloads would alter client data rather than system policy. Injection is limited to system-instruction surfaces.

## Consequences

The feature is off by default. Enabling it adds configured text to supported system-instruction surfaces; existing image-path exclusions remain. Each mapping owns one insertion, without mutating the caller's original request. It does not recursively remap its own output or deduplicate caller data. Count endpoints send only contents upstream; existing local estimation can still observe the mapped system instruction. Generation services snapshot the resolved string/null before account selection and reuse it through account/project remapping. Later requests observe new settings. Direct mapping and count entry points continue resolving their current setting. This change adds no prompt logging or configuration store and does not claim snapshots of unrelated configuration fields.

## Verification

Focused tests cover backward-compatible defaults and save-time synchronization before gateway startup. The D12 follow-up checks OpenAI/Anthropic/native Gemini placement, repeated and quoted caller text, configured whitespace, deterministic insertion and unchanged inputs. The D12 evidence (local artifact `d12-generation-history-evidence.json` in the 2026-10-11 review collection) separates controlled checks from unverified provider/cache effects.
The send-diagnostics follow-up (local artifact `d12-send-diagnostics-evidence.json` in the 2026-10-11 review collection) checks four-protocol unary/stream snapshots with configuration changes during account selection, including an initially disabled setting.
