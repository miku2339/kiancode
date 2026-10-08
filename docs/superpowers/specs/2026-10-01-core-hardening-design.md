# Core hardening — design

Date: 2026-10-01. Baseline commit: `17d571f`.

## Why

A read-only audit of this repository, re-checked against the source by a second pass, found that the core works under tests but has several behaviours that will fail in unattended, multi-principal or long-running use. This document fixes the intended behaviour. Each workstream below has its own implementation plan under `docs/superpowers/plans/`.

## Goals

1. Only the configured owner can act as owner; other principals get nothing unless explicitly granted, bounded by their level.
2. A tool failure that happened before anything was dispatched is an ordinary failure, and a task whose external outcome is unknown can be reconciled and continued.
3. Schedules and event triggers keep working unattended for as long as the account stays valid.
4. A parent task is never reported complete while delegated work is unverified.
5. Budgets are configurable and do not penalise non-ASCII text.
6. A stalled task tick is visible, and per-tick work does not grow with history where that is cheap to avoid.
7. The production store is exercised by the test suite, and acceptance runs leave a record.

## Non-goals

- Differentiated behaviour between levels 2, 3 and 4 (they share one ceiling until the owner defines the differences).
- A distinct `plan` mode (it stays equivalent to `ask`).
- Query pushdown for the task tick (`Store` interface change). Scoped in workstream F, implemented in a later plan.
- Narrowing the outage fallback path.
- Consolidating every private copy of scope matching.
- Changes to the native clients, channel adapters or the identity service. Follow-ups for those repositories are listed at the end.

## Global constraints

- Node.js 24 or later. TypeScript with two-space indent, single quotes, semicolons and explicit public interfaces.
- Tests use `node:test` and run with `tsx --test`. Behaviour is tested through public interfaces. `npm run check` (typecheck, tests, build) passes before delivery.
- No new runtime dependencies.
- SQLite is for development and tests; PostgreSQL is production. Entities already stored in a deployed database must remain readable without a data rewrite.
- Development authentication mode keeps its current behaviour.
- Errors are `DomainError(code, message, statusCode)` with snake_case codes. Existing codes and HTTP statuses do not change unless a workstream says so.
- The distinction between dispatched, confirmed and unknown external outcomes is preserved.
- No personal data, hostnames, secrets or production configuration in the repository.
- Line numbers in the plans refer to commit `17d571f`; function and symbol names are the stable anchors once earlier workstreams have landed.

## Execution order

G, A, C, B1, B2, D, E, F. G goes first so the PostgreSQL contract suite gates everything after it. C depends on A (`access_required`, level floor). B2 depends on B1. Later plans touch files changed by earlier ones; rebase the line references on the symbols named in each task.

---

## A — Access control and levels

- **A1 Default-deny.** In account and oidc modes a non-owner principal without an enabled `access` record is rejected with 403 `access_required`. A principal lacking issuer or subject is rejected the same way outside development mode, including stored principals revalidated in the background.
- **A2 Level floor.** Level 1 belongs to the configured owner subject only. Any other principal has level `max(reported level, 2)`.
- **A3 Level ceilings.** Effective scopes of a non-owner are the intersection of its record scopes and the ceiling for its level, using the same matching semantics as `requireScope`. Built-in ceilings: levels 2, 3 and 4 share `chat`, `task`, `memory`, `agent`, `artifact`, `notification` read and write, plus `model:read`, `workspace:read`, `device:read`, `approval:write`, `schedule:read`. Level 5 has an empty ceiling. An empty effective set is 403 `access_required`. Operators may override the ceiling per level with `auth.levelCeilings`.
- **A4 Grants.** `PUT /v1/access/:id` requires the owner. Scopes are validated. `*`, `admin:*` and `admin:grant` (in any accepted form) are rejected with 400 `invalid_scope`. The owner cannot write a record for its own id (400), so it cannot lock itself out. In account and oidc modes the id must be a 64-character lowercase hex principal id.
- **A5 Owner subject required.** In production with account or oidc authentication, startup and `config-check` fail when the owner subject variable is unset or empty.
- `access_required` is treated like the other authorization codes: tasks pause, schedules and triggers are rejected and disabled.
- One exported `scopeAllows(grants, scope)` in `src/auth.ts` is the canonical matcher; `requireScope` and `AccessService` use it. Other private copies are left alone.

Accepted consequences: existing non-owner principals are locked out until the owner grants access. In oidc mode every non-owner is level 5 and therefore denied unless the operator overrides the level-5 ceiling.

## B — Unknown external outcomes

### B1 Not dispatched

- `DomainError` carries a `notDispatched` marker set at the throw site. No code list and no subclass.
- A marked error from a write or external tool becomes an ordinary failed tool result fed back to the model. The internal workspace-operation path records a failed `tool_result`. `waiting_for_device` remains not-dispatched.
- Any other error thrown after dispatch may have started keeps today's behaviour.
- Every pre-dispatch throw site in the terminal, workspace, browser, Mac app, MCP and plugin tools, device dispatch and the device connector is classified.
- A Mac helper response may carry `notDispatched: true`; the core honours it.
- Not handled: a call in flight when the run is aborted still ends `unknown` and is recovered through B2.

### B2 Reconciliation

- `POST /v1/tasks/:id/reconcile`, for a principal that owns the task and holds `approval:write`, with the tool call being reconciled and a resolution:
  - `applied`: the side effect happened. Record it as confirmed and resume from the checkpoint with a tool result saying so, including an optional operator note.
  - `not_applied`: it did not happen. Record it as failed and resume. Nothing is replayed; if the model asks again a fresh approval is required.
  - `abandon`: the task becomes `cancelled` and the unknown outcome stays in its events.
- A `reconcile` event records who, when and the resolution.
- If the task became unknown while a cancel was pending, reconciliation records the resolution and the task ends `cancelled`.
- Internal workspace-operation tasks have no model loop: `applied` ends them `completed`, `not_applied` ends them `failed`. The shape of the synthetic result must be whatever the native client already decodes for operation results.
- Reconciliation releases the task's workspace write lease. The lease reconcile endpoint refuses only while the holder's device job is still queued or dispatched.
- A parent that was waiting on the reconciled child is restored. Dependents that already failed are not revived.

## C — Authorization lifetime of automations

- **C1 Durable delegation.** In account mode a saved schedule or trigger stores the actor without `expiresAt`. Each dispatch and each long-running step revalidates through the identity service authorization check and through `AccessService`. Stale `expiresAt` on stored rows is ignored at dispatch without rewriting data. Interactive tasks are unchanged. A durable task's grant is renewed after each successful revalidation, so an unattended task is not paused for a client sign-in after one hour.
- **C2 Transient versus permanent.** Only an explicit negative answer is permanent: HTTP 200 with `active: false` or a credential version mismatch. Everything else (network error, timeout, 5xx, 429, and also 401, 403 and 404, which on this route mean the core's own service credential or URL is wrong) is `identity_unavailable`: retried, logged, never a reason to disable an automation or fail a task.
- **C3** `setEnabled(true)` and `update` both refresh the stored authorisation. Re-enabling a one-shot schedule whose occurrence already exists does not run it again; the owner saves a new time.
- **C4** Event triggers record `authorizationFailedAt` and produce the same notification as schedules, with neutral wording.
- **C5** In oidc mode saving or enabling an automation fails with `unattended_automation_unsupported`. Drafts, listing and deletion still work. No token store is built.

## D — Delegated-work verification

- **D1** Verification runs inside the parent's integration run, before the final answer is accepted. `completed` therefore implies verification passed or was not required. No new task state.
- **D2** When verification cannot pass the task ends `failed` with `verification_failed` and a message naming the missing evidence. No per-tick retry.
- **D3** The reconciler no longer verifies and does bounded work per tick.
- **Evidence rule.** Evidence is required for workspace mutations made by children: the parent must afterwards read the changed path or run a successful check in that workspace. The integration prompt lists the child-changed paths. Confirmed external actions by children (terminal, plugin, browser, Mac app, export) were individually approved and confirmed; they are listed to the parent and recorded, not re-verified. This rule holds only if child external actions go through the same approval gate as the parent's; if they do not, children lose the external-action scopes instead.
- Rows already stored as `completed` with verification `pending` are left as they are.
- `TaskOrchestration.verification` gains `failed`. No persisted error-code field is added.

## E — Budgets and token estimation

- **E1** Optional `runtime.budgets` config: `task { maxCalls, maxTokens }` (defaults 20 and 100000) and `delegation { maxCalls, maxTokens }` (defaults 24 and 128000), validated with upper bounds 500 calls and 20000000 tokens. No per-request override.
- **E2** `estimateTokens(text)` is `ceil(asciiCodePoints / 4) + nonAsciiCodePoints`, iterating by code point. Provider-reported usage still replaces the estimate. The daily quota reservation uses the same function.
- Because the estimate is no longer an upper bound, a budget violation is raised only when a cumulative limit is exceeded, not when one call exceeds its own reservation.
- **E3** Exhaustion messages name the budget (task or delegation), the dimension (calls or tokens), the limit and the amount used. A parent that failed because a child ran out of budget carries the child's message.

## F — Tick observability

- **F1** Each failed tick is counted and reported. `/health/ready` reports degraded once three consecutive ticks have failed, exposing only the count and the time of the last failure. The first failure, every sixtieth consecutive failure and the recovery are logged through the server logger, which bootstrap enables at warn level.
- A failure in notification or agent reconciliation does not prevent the claim loop from running in the same tick; it is still reported.
- **F2** A terminal task's notification is published once per process lifetime, using the existing dedupe records seeded by a single scan. No marker is written to the task.
- **F3 (not implemented here)** Scope of a `Store` query pushdown for non-terminal and due rows is written down for a later plan. Whether it must precede production cutover depends on measured scan times in the deployed database.

## G — Production store tests and acceptance record

- **G1** One store contract suite runs against `SqliteStore` always and against `PostgresStore` when `KIANCODE_TEST_DATABASE_URL` names a disposable database. Without the variable the PostgreSQL cases are reported as skipped. With it, connection or privilege errors fail. The connection string is passed verbatim. Each case isolates itself in its own schema and cleans up. Known divergences between the two stores are recorded as `todo` cases, not fixed here.
- **G2** The acceptance script can write its report to a file named by an environment variable, including `startedAt`, `finishedAt` and the package version, and writes `status: 'failed'` with the error when it fails. `npm run acceptance` runs it. It is not part of `npm run check`.
- **G3** README documents both.

---

## Follow-ups outside this repository

- Native clients: handle 403 `access_required`; tolerate the `reconcile` event and extra `tool_result` fields; offer reconciliation for `unknown` tasks; treat `verification: 'failed'`.
- Channel service: `validateDelegation` now throws `identity_unavailable` on identity-service outages instead of returning false.
- Mac helper: return `notDispatched: true` for failures before any action.
- Identity service: provision the service credential for the authorization check in every environment; reject invalid legacy levels; validate invitation levels.
- Deployment: set the owner subject variable; the release activation script will now roll back a release whose tick is failing.
