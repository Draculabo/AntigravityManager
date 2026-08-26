# Feature Module Instructions

These instructions supplement the repository root `AGENTS.md` for `src/modules/`.

## Ownership

- A feature owns its components, hooks, actions, types, services, IPC handlers, repositories and feature-specific server code.
- Keep behavior in the module that owns its language and lifecycle. Visual reuse alone does not make a feature component generic.
- Expose a narrow public type, service or hook when another module has a real consumer. Do not deep-import another feature's internal file as an informal API.
- Move a capability to `src/shared` only after it has multiple consumers and no remaining feature-specific policy.

## IPC and boundaries

- Define runtime schemas beside the feature boundary they validate.
- Feature routers translate transport input into feature service calls; they do not duplicate domain behavior.
- Keep Electron objects, Node-only modules and credential/database implementations out of renderer bundles.
- Return domain-specific failures from the owner and let the global IPC layer convert them into transport-safe errors.

## React and UI

- Feature UI lives under the owning module; generic primitives remain in `src/components/ui`.
- Use Radix primitives, Tailwind utilities and existing component variants before introducing a new UI abstraction.
- Put user-visible strings in `src/localization` and use kebab-case translation keys.
- Preserve loading, empty, error, cancellation and retry behavior when changing an asynchronous flow.

## Tests and module size

- Tests should exercise the feature's public behavior or stable output, not private call order.
- Update adjacent integration tests when a service, IPC contract or shared type changes.
- Keep new functionality out of a production file already near 800 lines unless the behavior cannot have a coherent owner elsewhere. Prefer cohesive modules below roughly 500 production lines.
- Do not create a helper or abstraction used once unless it names a durable concept or isolates a meaningful boundary.
