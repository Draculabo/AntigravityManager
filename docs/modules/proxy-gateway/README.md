# Proxy Gateway Documentation

The proxy-gateway module owns local API routing, upstream protocol conversion, model selection,
gateway administration and coding-tool configuration. Use these references for behavior owned by
that module; cross-cutting runtime and security contracts remain in the root-level documents.

## Current behavior

- [Compatibility reference](compatibility.md): request, response, stream and client compatibility.
- [Account leases](account-leases.md): token and project persistence for selected proxy accounts.
- [Schema conversion](schema-conversion.md): schema selection, conversion limits and diagnostics.
- [Coding tool configuration](agent-tools.md): configure and recover Claude Code, Codex and
  OpenCode connections to the local gateway.

## Acceptance and troubleshooting

- [Live agent acceptance](acceptance/live-agent.md): real client request and traffic evidence.
- [Media and thinking acceptance](acceptance/media-thinking.md): focused protocol checks for
  media and multi-turn reasoning/tool flows.
- [Proxyman setup on Windows](debugging/proxyman-setup-windows.md): install and prepare capture.
- [Proxyman debugging](debugging/proxyman.md): capture the official client and this application's
  traffic paths.

For change-to-evidence selection, use the central [testing strategy](../../testing.md). For client
settings recovery and sensitive local files, use [security and data boundaries](../../security.md).
