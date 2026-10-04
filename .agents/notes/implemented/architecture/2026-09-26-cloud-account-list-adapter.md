# Agent Note: Cloud Account List Adapter

Status: implemented

## Problem

The renderer account list computed Classic, IDE and Agy active flags inside an Electron IPC handler. The standalone Node core could not reuse that handler without importing desktop-only behavior. Duplicating the rules in core RPC would risk inconsistent active badges and expose a second account projection path.

## Decision

The cloud-account feature owns one Node-safe list service. It loads accounts, performs the existing one-time OAuth-client-key backfill and refetch, refreshes the Classic and IDE process caches, resolves each target's active account, and projects the strict `CloudAccountView`. Both the embedded list adapter and the core `accountViews` RPC call that service. The existing `accountSummaries` RPC remains a distinct, smaller CLI contract. Electron explicitly selects the embedded account adapter before accepting renderer RPC; remote mode is available for a later ownership switch and propagates failures without using local persistence as a fallback.

## Alternatives considered

- Calling the Electron list handler from core would pull desktop behavior into the Node runtime.
- Reimplementing active-target rules in core would create two sources of truth for Classic credential-store precedence, IDE email fallback and Agy stored state.
- Sending repository account rows over core RPC would bypass the renderer view's secret exclusion.

## Consequences

The list service retains the prior read-triggered OAuth-client-key backfill, including its persistence side effect and refetch. The adapter now also routes proxy replacement/removal and deletion through bounded write operations described in the [proxy write note](../security/2026-09-26-account-proxy-write-boundary.md). Other account mutations, account ownership and the renderer transport remain embedded in Electron. A future ownership switch must select remote mode explicitly and validate the remaining account mutation surface separately.

## Verification

- Focused tests cover active-target rules, backfill/refetch and strict secret-free projection.
- A renderer route test exercises embedded and remote list results through the real private pipe/socket and the production core RPC operation; failure tests confirm remote mode does not fall back.
- Type checking, runtime-boundary enforcement, agent contracts and the standalone core build validate the new Node-side dependency path.
