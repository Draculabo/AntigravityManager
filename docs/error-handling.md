# Failure Ownership and Recovery

Use this reference when designing or reviewing errors, retries, cancellation, background tasks or user-visible failure reports. Feature modules own their failure behavior. Existing [security and diagnostic rules](security.md) govern sensitive data and reporting; this document does not introduce a new error framework or retry mechanism.

## Define failure and state together

Expected failures use the owning module's typed errors or discriminated results with stable machine codes. Narrow caught values with `instanceof` for known runtime error classes and use the existing codec for serialized IPC, HTTP or worker errors. Validate external data before trusted use; do not infer error identity from message text or assume a deserialized error retains its prototype. Preserve causes within the trusted owner and project only permitted fields across processes.

For each operation that can partially change state, define:

| Question                       | Required decision                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Who handles the failure?       | The owner that can determine the affected state and decide whether dependent work is safe.                   |
| What effects occurred?         | Distinguish no effect, partial effects, confirmed completion and an unknown outcome using observed evidence. |
| Who restores state?            | Name the recovery owner, required backup and observable restoration check.                                   |
| Can it continue or retry?      | Establish the next operation's preconditions, idempotency, cancellation and deadline.                        |
| Who reports the final outcome? | Name the UI, CLI or background owner and the safe action available to the user.                              |

Document non-obvious guarantees at the owning API. Record durable recovery decisions in an Agent Note; implementation details remain with the feature.

## Recover at the state owner

Catching an exception stops propagation; it does not reverse mutations. Continue dependent work only after its state owner establishes that the required conditions hold. Otherwise stop that work, contain invalid state and report the failure. Logging alone does not restore state, and unexpected defects must not become successful results.

Before credential or durable-state mutation, capture the state needed for recovery using the feature's existing protection and storage policy. Verify restoration through the authoritative store rather than a successful write call. Recovery failure remains visible alongside the original error; it must not overwrite that error or be reported as successful rollback.

A response lost after dispatch leaves the remote effect uncertain until readback establishes it. Reconcile through existing authoritative state when available before repeating a mutation. Do not automatically replay OAuth, switch accounts or retry writes solely because a transport failed.

Retries belong to the component that knows whether repetition is safe. Finite operations need bounded attempts or an overall deadline, cancellation and cleanup. Long-running supervision needs an explicit lifecycle owner and observable degraded state. Cancellation can leave partial effects; inspect the same recovery guarantees as other failures.

## Report useful, truthful outcomes

Final reports identify the affected operation, a readable summary, known impact, uncertainty and a safe next step. Use the application's locale resources for UI copy and the existing diagnostic reference for support. A successful diagnostic capture does not establish remote storage, recovery or business success.

Choose a persistent UI state or accessible default log when invalid state survives a toast. Preserve the primary failure when reporting fails, using an independent bounded fallback that respects redaction and reporting consent. Background tasks retain handling, cleanup and final-report ownership.

For example, if system credentials changed but a client file write failed, establish both stores' state and verified recovery before offering retry. If process close succeeds but saving a conversation fails, report both observed outcomes independently.

## Verify the guarantees

Use the owning tests and existing [acceptance scripts](../scripts/README.md) to observe the promised result. Select only failure points the changed operation can reach: before mutation, partial completion, unknown remote completion, cancellation, failed recovery or failed reporting. Verify persisted state, stopped dependent work, released resources and user-visible outcomes, rather than only that an exception was caught.

Synthetic failures establish the injected path only. Native keyring, installed-client identity, installer recovery and live-provider acceptance require their corresponding environment evidence from [testing strategy](testing.md).
