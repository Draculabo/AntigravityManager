# Agent Note: Additional agent connection profiles

Status: implemented

## Problem

Qwen Code, Gemini CLI and Pi can use the gateway after configuration in their native formats.
Gemini CLI and Pi can require two edits within one connection operation.

## Decision

Reuse the connection profile owner and its encrypted recovery state. Qwen Code and Pi select
the OpenAI Chat adapter. Gemini CLI selects the existing native Gemini adapter. The owner
orders provider configuration before activation, and restores activation before removing
its provider. Save an encrypted intent for the second write and require both files to match
the recorded sources before continuing after interruption.

## Alternatives considered

Independent file operations could report partial activation and leave a default that refers
to a removed provider. A separate gateway protocol or credential store would duplicate the
existing owners for the supported requests.

## Consequences

Agent-specific field mapping stays outside the gateway execution path. Owner compatibility
17 is required because older owners cannot parse the new clients or a pending multi-file
write. See the [connection guide](../../../../docs/modules/proxy-gateway/agent-tools.md#qwen-code-gemini-cli-and-pi)
and the [upgrade guide](../../../../docs/upgrade-guides/next/connection-profiles.md).

## Verification

The focused native profile tests cover add, activation, removal, recovery from a completed
first write, and refusal when the companion has been edited independently.

On Windows, Qwen Code 0.28.0 and Gemini CLI 0.69.0 read a local fixture through their tools,
sent its contents to the live gateway, and restored the original configuration on removal.
Pi 0.73.1 verified model selection, authentication, streaming, the read tool round trip,
and configuration restoration with a controlled loopback OpenAI Chat endpoint. In the live
gateway run, the upstream returned HTTP 429 with `RESOURCE_EXHAUSTED` for Pi.
