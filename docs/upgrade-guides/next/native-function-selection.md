# Upgrade guide: Declare functions selected by native Gemini requests

Target version: next

## Affected users

Native Gemini clients sending `functionCallingConfig` or `function_calling_config` with
explicit function selection.

## Required action

Include at least one function declaration when mode is `ANY`. Every name in
`allowedFunctionNames` or `allowed_function_names` must match a function declared in the
same request. Invalid selections return HTTP 400 before an account is selected or an
upstream request is sent. Correct the declaration or remove the invalid selection before
retrying.

## Data and recovery

No data migration is required. Both aliases retain valid provider extension fields.
The gateway preserves runtime argument values and the native default tool policy.

## Downgrade

An older gateway may forward an invalid selection to the provider. Client declarations
that satisfy these checks also work with the older admission path.

## Verification

Controlled service checks cover both aliases and unary/stream execution, with invalid
targets rejected before account selection. See the [schema reference](../../modules/proxy-gateway/schema-conversion.md).
