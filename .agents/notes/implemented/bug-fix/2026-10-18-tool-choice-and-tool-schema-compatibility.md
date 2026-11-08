# Agent Note: Preserve tool choice and ordinary tool contracts

Status: implemented
Supersedes: [Preserve client tool selection through the gateway](../../archived/bug-fix/2026-10-08-tool-choice-preservation.md)

## Problem

The OpenAI and Anthropic adapters supplied a default `VALIDATED` function choice when the
client omitted `tool_choice`. That changed client intent at the Google boundary. Search
built-ins were also identified by names, so an ordinary function named `web_search` or
`google_search` could be converted to server search. A function named `apply_patch` could
similarly receive the freeform custom-tool schema and argument adapter even when the client
declared it as a normal function.

Schema cleanup converted some numeric enums to strings without changing their declared type,
retained empty string enum values and treated boolean/object values inconsistently.

## Decision

OpenAI and Anthropic requests with no `tool_choice` now omit
`functionCallingConfig`; the independent `includeServerSideToolInvocations` flag remains.
Explicit `auto`, `none`, `required`/`any` and named function choices map to AUTO, NONE, ANY
and ANY with the selected declared name. Unsupported choices, missing or undeclared names,
forced calls without function declarations and requests mixing a declared Google Search
built-in with functions fail as invalid client requests. Validation happens before account
selection. Responses WebSocket validation happens before request or prewarm state is
published. Native Gemini's existing boundary default is unchanged.

Ordinary functions remain ordinary even when their names are `web_search`, `google_search`
or `apply_patch`. Google Search conversion requires a recognized explicit built-in type.
The apply_patch freeform schema and argument adapter run only when the client declared the
matching tool as `type: custom`. The tool name, description and runtime argument object for
ordinary functions are preserved without command guessing or length-based truncation.

Schema preparation uses the same explicit built-in type predicate as tool classification.
An ordinary search-named function therefore passes declaration normalization and budgets
before the mapper receives prepared schemas. This keeps the preparation path consistent
with the mapper's ordinary-function classification.

Native Gemini admission validates explicit `ANY` and allowed function names independently
for the camel and snake aliases. Missing functions or undeclared names fail before account
selection. Provider extension fields and the default policy remain owned by the native
protocol adapter.

Tool Schema enum values are serialized to strings consistently. Literal empty strings are
removed, whitespace-only strings remain, and an enum emptied by that rule is removed.
Nonempty enums set the corresponding Schema node type to `string`; `const` follows the same
rule when converted to an enum. This changes declarations and can produce string arguments
for tools that previously expected numeric or boolean values. Runtime arguments are not
coerced to match a declaration.

Existing local JSON Pointer resolution, conversion budgets, diagnostics, request-scoped
preparation reuse, successful Schema caching and bounded degradation remain in force.
This change does not establish live Google acceptance.
The D05 follow-up recovers misplaced tool declaration keywords identified during schema review. Named type or reference declarations stored in an object's `items` can be
recovered into `properties`, with existing properties taking precedence. Array declarations
keep `items` and drop misplaced `properties`. Array cleanup follows reference resolution and
effective type selection so an explicit object sibling can retain its inherited properties.
These repairs operate on prepared declaration copies under the existing conversion budget.

## Alternatives considered

- Keeping `VALIDATED` for compatibility would keep the proxy's implicit function policy in
  requests where the client supplied no choice.
- Inferring built-ins or custom commands from their names would keep misclassifying
  user-defined functions with common names.
- Coercing returned arguments to the rewritten enum type could alter executable inputs and
  hide client/provider mismatches.
- Combining Google Search and function declarations in a single upstream tool list was
  rejected because the supported upstream request shape cannot represent that combination.

## Consequences

Clients that relied on the proxy's former default may see different text-versus-tool
selection. Numeric and boolean enum parameters can arrive as strings after the upstream
follows the normalized declaration. Unsupported or unsatisfiable explicit choices now fail
before consuming an account attempt. Errors retain protocol-specific invalid-request
classification.

## Verification

Focused unit coverage verifies tool-choice mapping and rejection through Anthropic service
admission, string and structured enum normalization, ordinary versus built-in search
classification, ordinary versus declared custom apply_patch behavior, Responses WebSocket
prewarm state, and WebSocket error events. The local synthetic suites do not establish live
provider acceptance. The domain's real acceptance remains scheduled with the other 28
in-scope domains.

The 2026-10-18 focused run passes 122 tests across 9 files under Node 24.22.0 on Windows.
The same combined D03/D05 run passes 180 tests across 16 files.
