# OpenAI-compatible session history

`POST /v1/chat/completions` remains stateless by default. Clients that already resend the full
`messages` array do not need this extension.

Antigravity Manager can keep conversation history in memory when a request includes an explicit
`session_id`:

```json
{
  "model": "gemini-3-flash",
  "session_id": "interview-2026-07-11",
  "messages": [{ "role": "user", "content": "Remember this context from the first turn." }]
}
```

Subsequent requests may send only the newest message with the same `session_id`. The gateway adds
stored user, assistant, and tool-call messages before forwarding the request upstream.

Use an unguessable ID per logical conversation. Requests that share a `session_id` intentionally share
the same history.

Requests for the same session are processed in order. A later turn waits until the preceding response
has completed, including consumption or cancellation of a streaming response. Different session IDs
remain independent and can run concurrently.

## Controls

- `session_reset: true` clears the stored history before the current turn.
- `session_store: false` makes the current request stateless without deleting stored history.
- `extra.session_bootstrap` or `extra.session_bootstrap_context` adds initial system context once.
- `extra.session_bootstrap_messages` adds initial OpenAI-compatible messages once.

History is process-local, expires after six hours of inactivity, and is bounded by both session count
and serialized character size. Restarting Antigravity Manager clears it. Use client-managed `messages`
when history must survive restarts or be stored durably.

The gateway uses `session_id` as the sole history key and does not authenticate ownership of that ID.
Treat it as a secret, keep the gateway bound to a trusted interface or place authentication in front of
it, and never reuse a session ID between clients that must not share context.

This is an Antigravity extension, not a standard Chat Completions field. The standard OpenAI guidance
is to manage Chat Completions history in the client or use the stateful Responses and Conversations
APIs: <https://developers.openai.com/api/docs/guides/conversation-state>.
