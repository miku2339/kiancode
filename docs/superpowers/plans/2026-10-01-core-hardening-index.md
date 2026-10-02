# Core hardening — plan index

Spec: `docs/superpowers/specs/2026-10-01-core-hardening-design.md`. Baseline commit: `17d571f`.

Execute the plans in this order. Each one assumes the ones above it have landed; modifications are anchored on symbol names and quoted source lines, with line numbers as of the baseline.

| Order | Plan | Tasks | Scope |
| --- | --- | --- | --- |
| 1 | `2026-10-01-core-hardening-g-store-contract.md` | 7 | Store contract suite for SQLite and PostgreSQL; acceptance report file |
| 2 | `2026-10-01-core-hardening-a-access.md` | 8 | Default-deny, level floor, level ceilings, owner-only grants, owner subject required |
| 3 | `2026-10-01-core-hardening-c-automation-auth.md` | 12 | Durable authorisation for schedules, triggers and their tasks |
| 4 | `2026-10-01-core-hardening-b1-not-dispatched.md` | 12 | Not-dispatched marker and classification of tool throw sites |
| 5 | `2026-10-01-core-hardening-b2-reconcile.md` | 9 | `POST /v1/tasks/:id/reconcile` for tasks with an unknown outcome |
| 6 | `2026-10-01-core-hardening-d-delegation-verify.md` | 7 | Delegated work is verified before the parent completes |
| 7 | `2026-10-01-core-hardening-e-budgets.md` | 10 | Configurable budgets, script-aware token estimate, clearer exhaustion messages |
| 8 | `2026-10-01-core-hardening-f-tick-observability.md` | 6 | Tick failure reporting, readiness, phase isolation, one-time notification publish |

## How the plans were checked

Every task was run red then green in a private copy of the repository while the plan was written. A second reviewer then replayed each plan from its text alone on a fresh copy, stacked on the earlier plans, and corrected the plan where the replay disagreed.

Not verified, because the environment could not provide it:

- Any PostgreSQL case (no database was reachable). After plan G, run `test/store.test.ts` with `KIANCODE_TEST_DATABASE_URL` pointing at a disposable database before starting plan A. Expected: 54 tests, 44 pass, 0 skipped, 10 todo. A failure there is a finding to report, not something to fix inside plan G.
- The passing path of `npm run acceptance` (needs PostgreSQL, Bubblewrap and a model provider).
- Node 24 and Linux. All runs were on macOS with a newer Node.
- The final stack of all eight plans was not replayed end to end in one pass; each plan was replayed on the stack of plans before it.

## Before deploying

- Plan A: every existing non-owner principal is denied until the owner writes an access record for it. Production startup and `config-check` fail unless the owner subject variable is set.
- Plan C: automations that are still marked enabled but whose stored authorisation had expired will start running again at their next occurrence. Review enabled schedules and triggers first. The identity-service credential for the authorisation check must be provisioned, otherwise automations retry indefinitely.
- Plan B1: device connectors built from older code keep reporting pre-dispatch failures as unknown until they are rebuilt.
- Plan B2: releasing a workspace write lease through task reconciliation needs `task:write` and `approval:write`, not owner level.
- Plan D: only `npm test`, `npm run test*`, `swift test`, `pytest` and `cargo test` count as a workspace-wide check; otherwise the parent must read each changed path.
- Plan E: raise `runtime.budgets.task.maxTokens` for long multi-step tasks; the default is cumulative across calls. Remove the `runtime` block before rolling back to an older build.
- Plan F: the server logs at warn level to stdout. The release activation script in the integration repository passes on the first ready response, so it will not roll back a release whose tick starts failing later.
