# TEST READY — Antigravity Manager Multi-Instance Workspace Profile Manager

## Status: READY

The automated unit and non-regression test suite for the Multi-Instance Workspace Profile Manager project is fully authored, typed, and structured under `src/tests/unit/`.

---

## 1. Test Artifacts Summary

| Category                             | File Path                                                                                                                | Scope & Purpose                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Test Infrastructure**              | [`TEST_INFRA.md`](./TEST_INFRA.md)                                                                                       | 4-tier testing methodology, invariants, and traceability matrix                     |
| **R1: Data Model & CRUD**            | [`src/tests/unit/workspace-profile-persistence.test.ts`](./src/tests/unit/workspace-profile-persistence.test.ts)         | Tier 1 & Tier 2: SQLite DDL, schema, and CRUD repository persistence                |
| **R1: IPC & Picker**                 | [`src/tests/unit/workspace-profile-router.test.ts`](./src/tests/unit/workspace-profile-router.test.ts)                   | Tier 1 & Tier 2: oRPC procedures and native directory chooser                       |
| **R2: Launch Context & Isolation**   | [`src/tests/unit/workspace-launch-context.test.ts`](./src/tests/unit/workspace-launch-context.test.ts)                   | Tier 1 & Tier 2: Non-conflict multi-instance launch context resolution              |
| **R3: Credential Provisioning**      | [`src/tests/unit/workspace-credential-provisioning.test.ts`](./src/tests/unit/workspace-credential-provisioning.test.ts) | Tier 1 & Tier 2: SQLite ItemTable credential & device profile injection             |
| **R5: Non-Regression & Concurrency** | [`src/tests/unit/workspace-non-regression.test.ts`](./src/tests/unit/workspace-non-regression.test.ts)                   | Tier 3 & Tier 4: Multi-instance concurrency, targeted kill & classic non-regression |

---

## 2. Test Execution Commands

```bash
# Run all workspace profile unit test suites
pnpm vitest run src/tests/unit/workspace-*.test.ts

# Run individual test suites
pnpm vitest run src/tests/unit/workspace-profile-persistence.test.ts
pnpm vitest run src/tests/unit/workspace-profile-router.test.ts
pnpm vitest run src/tests/unit/workspace-launch-context.test.ts
pnpm vitest run src/tests/unit/workspace-credential-provisioning.test.ts
pnpm vitest run src/tests/unit/workspace-non-regression.test.ts

# Typecheck test suites against project schema
pnpm tsc -p tsconfig.json --noEmit
```

---

## 3. 4-Tier Test Coverage Matrix

| Tier       | Focus Area                             | Test Cases Included                                                                                                                            | Target Requirement             |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Tier 1** | Primary CRUD Operations                | Profile creation with UUID, listing newest first, lookup by ID, partial field updating, last launched tracking, deletion                       | **R1** (Persistence)           |
| **Tier 1** | IPC Endpoints & Folder Chooser         | oRPC handlers for `list`, `get`, `create`, `update`, `delete`, `launch`, `stop`, and native `selectDirectory`                                  | **R1** (IPC Router)            |
| **Tier 1** | Launch Context & Args Construction     | Binding profile `--user-data-dir` and positional project path arguments into launch context                                                    | **R2** (Runtime)               |
| **Tier 1** | SQLite & Device Credential Injection   | Injecting OAuth protobuf (`antigravityUnifiedStateSync.oauthToken`), `antigravityAuthStatus`, `antigravityOnboarding = 'true'`, and device IDs | **R3** (Credentials)           |
| **Tier 2** | Schema Boundary & Empty Fields         | Rejecting empty/whitespace profile names, empty account IDs, and empty project paths                                                           | **R1** (Validation)            |
| **Tier 2** | Folder Picker Cancelation              | Native dialog returning `canceled: true` safely returns `null` without throwing                                                                | **R1** (IPC)                   |
| **Tier 2** | Multi-Instance Non-Conflict            | Two concurrent processes with distinct `--user-data-dir` do not trigger `directory-conflict`                                                   | **R2** (Process Isolation)     |
| **Tier 2** | Genuine Directory Conflict Detection   | Conflicting arguments within the same profile context properly trigger `directory-conflict`                                                    | **R2** (Conflict Guard)        |
| **Tier 2** | Transactional Rollback & DB Resilience | Forced SQLite insertion failures roll back cleanly without leaving corrupt state                                                               | **R3** (SQLite Resilience)     |
| **Tier 2** | Directory Isolation Verification       | Writing credentials for Profile A leaves Profile B's directory and SQLite tables untouched                                                     | **R3** (Data Boundary)         |
| **Tier 3** | Default & Isolated Coexistence         | Running an isolated profile instance does not disrupt or cause conflict in classic default context                                             | **R5** (Coexistence)           |
| **Tier 3** | Classic & `agy` Account Switching      | Classic and CLI switching targets continue using credential stores without touching workspace profiles                                         | **R5** (Non-Regression)        |
| **Tier 4** | Concurrent Multi-Instance Status       | Independent PID and status mapping for Profile A (PID 101) and Profile B (PID 202) running concurrently                                        | **R5** (Real-World)            |
| **Tier 4** | Targeted Process Stop Isolation        | Terminating Profile A kills only PID 101's tree, leaving Profile B (PID 202) active and unaffected                                             | **R5** (Process Lifecycle)     |
| **Tier 4** | Launch Idempotency                     | Launching an already active workspace profile detects running status without spawning duplicate processes                                      | **R5** (Lifecycle Idempotency) |

---

## 4. Implementation Defects Discovered (Escalation)

During test authoring and compilation verification, the following defects in implementation code and environment configuration were identified:

1. **Vite 5 / Vitest 4 Peer Dependency Incompatibility (`package.json`)**:
   - `package.json` specifies `"vite": "^5.4.21"` and `"vitest": "^4.0.8"`. Vitest 4 requires Vite 6 (`^6.0.0`) because Vitest 4 imports `vite/module-runner` and accesses Vite 6 Environment APIs (`server.environments`). When running `pnpm test`, Vitest fails to initialize.
   - _Recommended Resolution_: Update `vite` to `^6.0.0` or align `vitest` to `^2.1.8`.
2. **Missing Property in `PathApi` (`src/shared/platform/paths.ts:690`)**:
   - `getProfileUserDataDir` calls `pathApi.basename(profileId.trim())`, but `type PathApi` on line 15 is defined as `Pick<typeof path, 'dirname' | 'join' | 'normalize' | 'resolve'>`, omitting `'basename'`.
   - _Recommended Resolution_: Add `'basename'` to `type PathApi` in `paths.ts:15`.
3. **Missing Generic Type Arguments in `toWorkspaceORPCError` (`src/modules/workspace/ipc/router.ts:23`)**:
   - `export function toWorkspaceORPCError(error: unknown): ORPCError` fails TypeScript compilation because `ORPCError<TCode, TData>` requires 2 type arguments in `@orpc/server`.
   - _Recommended Resolution_: Change return type to `ORPCError<any, any>` or infer without explicit generic return type.
