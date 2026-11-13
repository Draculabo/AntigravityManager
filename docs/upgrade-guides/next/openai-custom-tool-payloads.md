# Upgrade guide: OpenAI custom tool payloads

Target version: next

## Affected users

This applies to OpenAI-compatible clients that handled `apply_patch` as a custom tool based on
its name, depended on Manager to repair patches, or read declared Chat custom tools from
`function.arguments`.

## Required action

1. Declare the tool with the type your client executes. A `function` declaration uses JSON
   arguments. A `custom` declaration uses freeform text.
2. For Chat custom tools, read `tool_calls[].custom.input`. For Responses, read
   `custom_tool_call.input` and the corresponding input events. Send the tool's actual result
   with the matching call ID.
3. Supply valid patch syntax for your executor. Manager forwards the supplied text without repair.

## Data and recovery

Existing session storage requires no conversion. Previously stored tool calls are read in their
recorded shape. New Responses requests preserve full tool failure text and supported media.

## Downgrade

An earlier gateway may emit function-shaped Chat custom calls, repair patch text, or omit
repeated failure text again. Use the response parser appropriate to the running gateway version.
There is no session database migration to reverse.

## Verification

Call a function and a custom tool in separate requests with the same name. Check the returned
types and full payloads. Send two tool results whose first eight lines match and whose final lines
differ. Check that both results remain associated with their original call IDs. The
[HTTP regression suite](../../../src/tests/unit/openai-tool-declaration-http.integration.test.ts)
exercises these paths through the local gateway.
