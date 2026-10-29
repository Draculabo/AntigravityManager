# Antigravity Manager Product Reference

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface uses web technologies inside an Electron desktop application for
Windows, macOS and Linux. This platform value describes the interface technology;
it does not imply a browser-only product or a native mobile application.

## Users

The primary user is an individual AI developer who manages multiple Google
accounts and connects their everyday coding tools. They use Manager alongside
Antigravity clients and tools such as Claude Code, Codex and OpenCode.

## Product Purpose

Help developers manage the Google accounts used by Antigravity, understand their
model quota, switch client accounts and connect coding tools through a local API
gateway.

The first product priority is a newcomer's first successful workflow: add an
account, inspect its quota and complete a first request from a connected coding
tool. A saved configuration alone is not evidence of a working connection; the
request and its result must be observable in Traffic Monitor.

## Positioning

Manager brings account management, quota visibility, Antigravity client switching
and coding-tool gateway setup into one local desktop workflow. These capabilities
support the developer's existing clients and tools. They do not guarantee model
access, additional quota or successful upstream requests.

## Operating Context

- First use starts with browser authorization or a reviewed import of local
  accounts, followed by a quota refresh.
- To connect a coding tool, the user starts API Proxy, acknowledges its first-use
  account-risk warning, reviews and applies the tool configuration, reopens the
  tool and verifies a small request in Traffic Monitor.
- Official client switching targets Antigravity Classic, Antigravity IDE or agy
  CLI. Users save work before switching a desktop client and verify the identity
  in the official client afterward.
- Client account switching and account selection for proxy requests have separate
  policies. The interface must keep their effects understandable.

See the [first-use instructions](README.md#first-use),
[account guide](docs/modules/cloud-account/overview.md) and
[tool configuration and recovery guide](docs/modules/proxy-gateway/agent-tools.md).

## Capabilities and Constraints

- Existing workflows cover account authorization and import/export, quota views,
  manual and automatic client switching, gateway configuration, request inspection,
  backups and diagnostics. Detailed behavior remains in the owning
  [module references](docs/modules/README.md).
- Quota views include five-hour, weekly and combined windows. Model access and
  quota availability depend on the account and upstream service.
- The gateway supports OpenAI, Anthropic and Gemini interfaces within the limits
  documented in the [gateway reference](docs/modules/proxy-gateway/README.md).
- The interface supports English, Chinese and Russian. User-visible copy belongs
  in the existing translation resources.
- Account operations, client configuration and backups can affect local state.
  Onboarding must explain relevant effects and preserve the existing confirmation
  and recovery behavior. Data and credential policy remains in
  [Security](docs/security.md).
- Renderer operations cross the existing typed preload/IPC surface; feature
  ownership and runtime boundaries remain defined by
  [Architecture](docs/architecture.md).

## Brand Commitments

The existing product name is Antigravity Manager. The repository contains the
existing [logo](docs/assets/logo.png).

The desktop interface uses the Signal Blue design system: cool neutral surfaces,
blue primary actions, readable typography and consistent spacing, radii and
control proportions. Implement visual and interaction patterns for Manager's
workflows using the existing Radix and Tailwind stack. [DESIGN.md](DESIGN.md) and
[its extensions](.impeccable/design.json) own the implemented visual contract.

## Evidence on Hand

- [README](README.md): current feature descriptions and first-use workflows.
- [Module references](docs/modules/README.md): behavior and operational limits.
- [Account overview capture](docs/assets/screenshot-main.png): an existing desktop
  interface reference, not proof of a newly rendered or validated screen.
- Existing screenshots and local demo activity do not establish customer
  endorsements, performance benchmarks or current upstream availability.

## Product Principles

1. Prioritize a newcomer's first successful account-to-tool workflow.
2. Make progress and the next required action clear at each setup step.
3. Distinguish saved settings from verified working behavior.
4. Keep account, client and proxy state understandable and failures diagnosable.
5. Preserve established local-data handling and recovery contracts.

## Open Decisions

- No product-specific accessibility standard or assistive-technology requirement
  has been confirmed during initialization.
- No quantitative onboarding target or additional brand voice commitment has been
  confirmed. Future work must not invent these as established requirements.
