# Agent Note: Unified generation plan ownership

# Agent Note: Generation plan ownership

Status: implemented
Date: 2026-10-19

## Problem

Registered model recipes returned before account caps were applied, while
unregistered paths converted negative budgets and model levels differently. The
same request could therefore produce different final thinking and output values
across protocol paths.

## Decision

Resolve a request into one generation plan after model routing and account
capability lookup. The plan distinguishes disabled, adaptive, level and fixed
budget states; applies source-specific precedence; then constrains both thinking
and output to the current account/model capability. Registered recipes cannot
bypass this final step.

## Alternatives considered

Keeping a separate planner in each protocol adapter was rejected because it
already caused divergent `0`, `-1` and effort behavior. Treating `32768` as an
adaptive sentinel was rejected because it is also a valid fixed budget.

## Consequences

Some previously accepted recipe values now reduce to an account cap or fail
explicitly when no legal combination exists. This is observable and diagnosable,
and prevents a later adapter from silently reopening disabled thinking or
raising output above the selected account's capability.

## Verification

See D09 implementation report (local artifact `D09-thinking-budget-implementation.md` in the 2026-10-11 review collection) and the focused generation-plan and constraint tests.
