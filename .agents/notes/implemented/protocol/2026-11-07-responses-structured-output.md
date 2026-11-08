# Agent Note: Responses structured output on the Gemini internal path

Status: implemented

## Problem

A Responses request can ask for JSON Schema and declare tools in the same turn.
The Gemini internal path previously forwarded both. Some successful JSON answers
also arrive wrapped in Markdown, which prevents clients from parsing output text
directly as JSON.

## Decision

Keep tool history and remove optional declarations and their configuration from
the Gemini internal request.
Reject a required or named choice at the existing HTTP and WebSocket validation
boundary. Normalize the Responses named choice before applying the shared policy.

Normalize only a complete valid JSON payload enclosed in a single outer fence
when the caller explicitly requests a JSON format and receives a normal final
answer. Store the same normalized result returned to the client.

## Alternatives considered

Removing all tool declarations without validating the choice could bypass an
explicitly required action. Applying fence cleanup to plain text could rewrite
an intentional Markdown example. Applying it to streaming would require changing
already emitted deltas or buffering output until completion.

## Consequences

A client that needs a tool and a JSON Schema answer can issue the tool call in one
request and supply its result with the schema in the next. The outbound omission
does not remove the tool declaration from session history. JSON parsing checks
syntax and leaves schema conformance to the existing upstream contract.

## Verification

The focused suite covers valid and invalid fences, streaming preservation, prior
tool results, forced tools, optional tools and WebSocket prewarm rejection.
Loopback HTTP uses controlled upstream replies. Installed-client and real-provider
verification require a separate isolated acceptance environment.
