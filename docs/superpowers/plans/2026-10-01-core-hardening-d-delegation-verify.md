# Delegated-Work Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parent task that delegated work is stored as `completed` only after its own integration run has verified every workspace change its children made; otherwise it ends `failed` with `verification_failed`, and the per-tick reconciler no longer verifies anything.

**Architecture:** `AgentCoordinator` gains an inventory of what the children of a plan did (`childSideEffects`) and applies the evidence rule to it inside `verifyIntegration`, which now runs while the parent is still `running`. `createTaskRunner` tells the parent what the children changed in the integration prompt and calls `verifyIntegration` when the integration run produces its final answer, before the `final` event is forwarded, so a failed check leaves `TaskService` through its existing failure path. `reconcileAgentTasks` loses its verification branches and only moves waiting parents forward.

**Tech Stack:** TypeScript (NodeNext modules, `.js` import suffixes), Node.js 24 `node:test` run through `tsx --test`, the generic entity `Store` (`SqliteStore` in tests), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section D)

## Global Constraints

- Node.js 24 or later. TypeScript with two-space indent, single quotes, semicolons and explicit public interfaces.
- Tests use `node:test` and run with `tsx --test`. Behaviour is tested through public interfaces. `npm run check` (typecheck, tests, build) passes before delivery.
- No new runtime dependencies.
- SQLite is for development and tests; PostgreSQL is production. Entities already stored in a deployed database must remain readable without a data rewrite.
- Errors are `DomainError(code, message, statusCode)` with snake_case codes. Existing codes and HTTP statuses do not change unless a workstream says so. This workstream says so once: the coordinator's `verification_required` (409) is replaced by `verification_failed` (409), the code the runtime already uses for an act run that ends with failed actions.
- The distinction between dispatched, confirmed and unknown external outcomes is preserved: a parent with an unconfirmed dispatch still ends `unknown`, never `failed`, when verification also fails.
- No personal data, hostnames, secrets or production configuration in the repository.
- Line numbers in the plans refer to commit `17d571f`; function and symbol names are the stable anchors once earlier workstreams have landed.
- Execution order is G, A, C, B1, B2, D, E, F. This plan runs after B2 and before E. E adds a seventh optional parameter to `createTaskRunner`; this plan does not add, remove or reorder any parameter of that function.
- Workstream rule (D1): no new task state. `TaskState` and every list of task states stay as they are. `completed` implies verification passed or was not required.
- Workstream rule (D2): a failed check ends the task `failed`; the message names the missing evidence; there is no retry per tick. No error-code field is added to `Task`: the code lives on the thrown `DomainError`, the text in `Task.error`, and `orchestration.verification` becomes `'failed'`.
- Workstream rule (legacy rows): a stored parent that is `completed` with verification `pending` is never rewritten.
- Workstream rule (files): `src/tasks.ts`, `src/http/server.ts`, `src/notifications.ts` and `src/bootstrap.ts` are not modified by this plan.

### Which evidence rule applies, and why

The spec makes the evidence rule conditional on whether a child's external actions pass through the same approval gate as its parent's. They do, so the rule in the spec applies as written and children keep their scopes:

- A child is an ordinary task. `TaskService` claims it and runs it through the same `createTaskRunner` and the same `AgentRuntime.run` as any other task.
- `AgentRuntime.executeToolCalls` (`src/runtime/agent-runtime.ts`) stops with `approval_required` for every tool whose `sideEffect` is not `'read'` unless the exact action hash is in `approvedActionHashes`. The hash covers the principal id, the task id, the tool-call id, the tool name and the arguments, so a parent's approval can never match a child's action.
- `AgentCoordinator.finishPreparation` creates every child with `approvedActionHashes: []`, and `TaskService.control` only accepts hashes that match that child's own `pendingActions`.

Task 1 pins this with a test (`a child agent stops for exact approval before an external tool runs`). If that test ever fails, stop: the evidence rule below is no longer safe.

The rule implemented by this plan:

1. Evidence is required only for workspace file changes made by direct children: a confirmed `workspace.write`, `workspace.patch` or `workspace.restore`.
2. A change is verified when the parent, at or after the time of that change, did one of the following, and the action was confirmed without error:
   - read the same path with `workspace.read`;
   - ran `terminal.run` with a test command that exited zero. This is "a successful check in that workspace" and covers every changed path. A test command is `npm test`, `npm run test…`, `swift test`, `pytest` or `cargo test` at the start of a command, optionally after environment assignments, in a command made only of `&&`-joined parts (no `;`, `|`, `||`, `&` or newline), so that exit code zero means the tests passed. A descriptor redirection such as `2>&1` is allowed, because it does not change the exit status, and white space around the whole command (a trailing newline included) is ignored;
   - ran `terminal.run` with `cat`, `test`, `git diff` or `git status` naming that path (the rule that exists today, unchanged).
3. Every other confirmed child action with side effect `write` or `external` (terminal, plugin, browser, Mac app, export) was individually approved and confirmed. It is listed to the parent in the integration prompt and recorded in the plan's evidence text. It is not re-verified and never fails the parent.

### Relation to the other plans

- Consumes nothing by name from G, A, C, B1 or B2. B1 edits the import line and the internal-operation branch of `src/runtime-adapter.ts` (lines 2 and 148-166); this plan edits line 8, inserts a function above line 123 and edits lines 256, 268, 297, 301 and 309-350, none of which is inside that branch. A `tool_result` that B2's reconcile endpoint records with `outcome: 'confirmed'` is a confirmed child action like any other. A parent that B2 requeues from `unknown` during integration finds its plan still `integrating` (Task 7 keeps it).
- Leaves for E: the six-parameter signature of `createTaskRunner`, the `delegateTool` function, the two delegation budget literals and the child-failure block inside `reconcileAgentTasks` (the line E changes is `const error = result.children.filter(...)`), all untouched.
- Every edit below was applied, and all tests of this plan pass, on three scratch copies: commit `17d571f`, a copy with plans G, A and C applied, and a copy with the B1 and B2 drafts applied. Each "Replace" block matched exactly once in all three.

## Review Focus

1. A parent answers without reading or testing a file its child changed — the task must end `failed` with an error that names the path, and at no point be stored as `completed`, get an assistant message, a `final` or `completed` event, or a `task_completed` notification. Pinned in Task 6 by `a parent that answers without checking a child change fails and nothing reports completion` (state, events, message, notifications) and in Task 2 by `an unread child change fails the parent and the message names only the missing path` (code, status and text).
2. A child ran an approved terminal command, plugin call, browser or Mac app action, or export — the parent must not fail because of it; the action is shown to the parent and recorded in the evidence, and it really was approved on the child. Pinned in Task 2 by `confirmed external child actions are recorded as evidence and never fail the parent`, in Task 5 by `the integration prompt lists child-changed paths and confirmed external child actions`, and in Task 1 by `a child agent stops for exact approval before an external tool runs`.
3. A parent checks the children's changes by running the test suite instead of reading every file, or runs a command whose exit code hides a failure (`npm test || true`, `npm test; echo done`, `npm test 2>&1 | tail -n 20`, a failing run) — a passing run must count for every changed path, also when it ends with a plain `2>&1` or a trailing newline, and the others must not count at all. Pinned in Task 2 by `a passing test command verifies every child change; other commands verify only the path they name`.
4. The database already holds parents stored as `completed` with verification `pending`, or a plan left `waiting` by a pause and resume under the old version — those rows must stay exactly as stored, each tick must do no event scan for them, and the tick must keep claiming other tasks. Pinned in Task 7 by `a parent stored as completed with pending verification is left as stored and costs no event scan` and `a plan left waiting by an earlier pause and resume no longer stops the tick for other tasks`, and in Task 2 by `a parent stored as completed with pending verification is left as stored when a late check fails`.
5. The owner pauses and resumes a parent while it is integrating — the parent must still complete once it has checked the children's changes, not fail with `integration_incomplete`. Pinned in Task 4 by `pausing and resuming a parent during integration keeps its plan integrating and the parent completes` and `resuming repairs a plan that an earlier version left paused or waiting during integration`.

## File Structure

- Modify `src/domain.ts` — `TaskOrchestration.verification` gains `'failed'`.
- Modify `src/agents/coordinator.ts` — the child side-effect inventory (`childSideEffects`), the evidence rule and its failure message, `verifyIntegration` usable while the parent is running, and `propagateControl` keeping a plan `integrating` across pause and resume.
- Modify `src/runtime-adapter.ts` — the integration prompt (`integrationPrompt`), the verification gate inside `createTaskRunner`, and `reconcileAgentTasks` without verification.
- Modify `README.md` — one bullet in the Components list.
- Create `test/delegation-verification.test.ts` — every new test of this plan, with its own small helpers. Later plans append their delegation tests to `test/agents-runtime.test.ts`; keeping this file separate avoids merge conflicts.
- Modify `test/agents-runtime.test.ts` — the two tests that expect the reconciler to verify: one is adjusted, one is deleted; nothing else in the file changes.

Not modified, on purpose: `src/tasks.ts`, `src/http/server.ts`, `src/notifications.ts`, `src/bootstrap.ts`, `test/agents-coordinator.test.ts` (its tests call `verifyIntegration` after a hand-written runner has completed the parent, which stays allowed) and `test/standalone.acceptance.ts`.

Conventions used by every task: local imports carry the `.js` suffix; tests are flat top-level `test(...)` calls, no `describe`; each test creates what it needs and closes it in `finally`. Run one file with `npx tsx --test test/<file>.test.ts`. `tsx` does not type-check, so a test can fail at run time with a `TypeError` where `npx tsc --noEmit` would report a missing property; both are shown where it matters.

Expected-output blocks are abridged: durations, stack traces and some summary lines are left out. The lines and counters that are shown must match.

---

### Task 1: Child side-effect inventory

The evidence rule needs one answer to "what did the children of this plan do": which workspace paths they changed, and which other approved actions they performed. This task adds that inventory as a public coordinator method. Task 2 uses it to verify, Task 5 uses it for the integration prompt. It also pins the fact the whole rule rests on: a child cannot perform a write or external action without its own exact approval.

**Files:**
- Modify: `src/agents/coordinator.ts` (`OrchestrationResults` lines 60-67, `ConfirmedAction` lines 87-93, module constants lines 95-97, `confirmedActions` lines 121-152, `resultPath` lines 161-170, new functions above `validateRequest` line 187, new method above `verifyIntegration` line 399)
- Create: `test/delegation-verification.test.ts`
- Test: `test/delegation-verification.test.ts`

**Interfaces:**
- Consumes (existing): `AgentCoordinator.prepare(ownerId, parentTaskId, request)`, `AgentCoordinator.requirePlan` (private), `Store.scan<TaskEvent>('event', ownerId)`, `TaskService.enqueue / drain / control / close`, `createTaskRunner(store, runtime, tools, artifacts?, coordinator?)`, `AgentRuntime`, `ModelProvider`. Task events are stored as `{ taskId, sequence, type, payload, at }`; `payload` of a `tool_dispatched` event carries `actionHash`, `sideEffect` and `toolCall { id, name, arguments }`, and `payload` of a `tool_result` event carries `actionHash`, `toolCallId`, `outcome`, `isError` and optionally `result { content }`.
- Produces:
  - `export interface ChildWorkspaceChange { path?: string; tool: string; actionHash: string; at: string }` — one entry per changed path (the latest confirmed change wins). `path` is the normalised workspace-relative path and is absent only when the tool result did not report one. `at` is the time of the confirmed result.
  - `export interface ChildExternalAction { taskId: string; tool: string; actionHash: string; arguments: Record<string, unknown> }` — every confirmed child action with side effect `write` or `external` that is not a workspace file change.
  - `export interface ChildSideEffects { changes: ChildWorkspaceChange[]; externalActions: ChildExternalAction[] }` — `changes` sorted by label.
  - `AgentCoordinator.childSideEffects(ownerId: string, planId: string): Promise<ChildSideEffects>` — throws `DomainError('not_found', …, 404)` for an unknown plan.
  - `export function childChangeLabel(change: ChildWorkspaceChange): string` — the path, or `<tool> (path not reported)` when the path is absent. Used by Task 2 (failure message, evidence) and Task 5 (prompt).
  - Module-private in `src/agents/coordinator.ts`, used by Tasks 2 and 3: `collectChildSideEffects(events: Array<Entity<TaskEvent>>, childIds: string[]): ChildSideEffects`, and the fields `ConfirmedAction.taskId` and `ConfirmedAction.at` (`at` is the time of the confirmed result).
  - `resultPath` also accepts `{ "restored": "<path>" }`, the result shape of `workspace.restore`; before this task a confirmed child restore had no recognisable path.
  - Test helpers in `test/delegation-verification.test.ts`, used by every later task: `principal`, `interface Step { tool; arguments?; sideEffect?; failed?; unconfirmed?; result? }` (`failed` records the result as a failed one, `unconfirmed` records the dispatch without any result), `emit(onEvent, taskId, steps)`, `interface Delegation { parentId; planId; childIds }`, `startDelegation(store, service, coordinator, childKeys): Promise<Delegation>`, `harness(steps, options?)` returning `{ store, service, coordinator, errors, start(childKeys?), close() }` (`options` is `TaskServiceOptions` plus `verifyInRun?: boolean`, default `true`), `integrate(h, planId)`, `isChild(task)`, `hasCode(code)`.

- [ ] **Step 1: Write the failing test**

Create `test/delegation-verification.test.ts` with exactly this content. The import block already contains everything the later tasks of this plan use; this repository does not enable `noUnusedLocals`, so the imports that are unused until then do not fail the type check.

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import type { Principal, ToolDefinition } from '../src/contracts.js';
import type { Conversation, Message, Notification, Task } from '../src/domain.js';
import { NotificationService } from '../src/notifications.js';
import { createTaskRunner, reconcileAgentTasks } from '../src/runtime-adapter.js';
import { AgentRuntime, type ModelProvider, type RunInput, type RunResult, type RuntimeEvent } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService, type TaskServiceOptions } from '../src/tasks.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';

const principal: Principal = {
  id: 'owner',
  level: 1,
  scopes: ['*'],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

interface Step {
  tool: string;
  arguments?: Record<string, unknown>;
  sideEffect?: 'read' | 'write' | 'external';
  failed?: boolean;
  unconfirmed?: boolean;
  result?: unknown;
}

type Emit = (event: { type: string; [key: string]: unknown }) => Promise<void>;

async function emit(onEvent: Emit, taskId: string, steps: Step[]): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const actionHash = `${taskId}:${index}:${step.tool}`;
    const sideEffect = step.sideEffect ?? 'read';
    await onEvent({
      type: 'tool_dispatched',
      actionHash,
      sideEffect,
      toolCall: { id: actionHash, name: step.tool, arguments: step.arguments ?? {} },
    });
    if (step.unconfirmed) continue;
    await onEvent({
      type: 'tool_result',
      actionHash,
      toolCallId: actionHash,
      sideEffect,
      outcome: step.failed ? 'failed' : 'confirmed',
      isError: step.failed ?? false,
      ...(step.result === undefined ? {} : { result: step.result }),
    });
  }
}

interface Delegation {
  parentId: string;
  planId: string;
  childIds: string[];
}

async function startDelegation(
  store: Store,
  service: TaskService,
  coordinator: AgentCoordinator,
  childKeys: string[],
): Promise<Delegation> {
  const conversation = await store.create<Conversation>('conversation', principal.id, {
    title: 'Delegation', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
  });
  const parent = await service.enqueue(principal, conversation.id, 'Coordinate the work');
  const plan = await coordinator.prepare(principal.id, parent.id, {
    key: 'work',
    strategy: childKeys.length > 1 ? 'experts' : 'single',
    children: childKeys.map((key) => ({ key, prompt: `Do the ${key} part` })),
    budget: { maxCalls: 8, maxTokens: 4_000 },
  });
  return { parentId: parent.id, planId: plan.id, childIds: plan.data.childIds };
}

interface Harness {
  store: Store;
  service: TaskService;
  coordinator: AgentCoordinator;
  errors: unknown[];
  start(childKeys?: string[]): Promise<Delegation>;
  close(): Promise<void>;
}

function harness(
  steps: (task: Entity<Task>) => Step[],
  { verifyInRun = true, ...options }: TaskServiceOptions & { verifyInRun?: boolean } = {},
): Harness {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const errors: unknown[] = [];
  const service = new TaskService(store, async ({ task, onEvent }) => {
    await emit(onEvent, task.id, steps(task));
    const orchestration = task.data.orchestration;
    if (verifyInRun && orchestration?.role === 'parent' && orchestration.phase === 'integration') {
      try {
        await coordinator.verifyIntegration(task.ownerId, orchestration.planId);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    }
    return { text: `${orchestration?.childKey ?? 'parent'} done` };
  }, { reauthorize: async (current) => current, ...options });
  return {
    store,
    service,
    coordinator,
    errors,
    start: (childKeys = ['worker']) => startDelegation(store, service, coordinator, childKeys),
    async close() {
      await service.close();
      await store.close();
    },
  };
}

async function integrate(h: Pick<Harness, 'service' | 'coordinator'>, planId: string): Promise<void> {
  await h.service.drain();
  await h.coordinator.queueIntegration(principal.id, planId);
  await h.service.drain();
}

const isChild = (task: Entity<Task>): boolean => task.data.orchestration?.role === 'child';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && 'code' in error && error.code === code;
}

test('a child agent stops for exact approval before an external tool runs', async () => {
  const store = new SqliteStore();
  const executed: string[] = [];
  const external: ToolDefinition = {
    name: 'plugin.call',
    description: 'Send one message through a plugin.',
    inputSchema: { type: 'object', properties: {} },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executed.push('plugin.call');
      return { content: 'sent' };
    },
  };
  let parentId = '';
  const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat(request) {
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (request.context!.taskId === parentId) {
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'delegate', name: 'agent.delegate', arguments: { prompt: 'Send it.', childKey: 'sender' } }],
        },
        usage,
      };
    }
    if (request.messages.at(-1)!.role === 'tool') return { message: { role: 'assistant', content: 'Sent.' }, usage };
    return {
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'send', name: 'plugin.call', arguments: { to: 'list' } }] },
      usage,
    };
  } };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming', 'tools'] }],
    tools: [external],
  });
  const coordinator = new AgentCoordinator(store);
  const tasks = new TaskService(store, createTaskRunner(store, runtime, [external], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Gate', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const parent = await tasks.enqueue(principal, conversation.id, 'Delegate the send');
    parentId = parent.id;
    await tasks.drain();

    const plan = (await store.scan<OrchestrationPlan>('agent_plan', principal.id))[0]!;
    const childId = plan.data.childIds[0]!;
    const waiting = (await store.get<Task>('task', childId, principal.id))!;
    assert.equal(waiting.data.state, 'waiting_for_approval');
    assert.deepEqual(waiting.data.pendingActions.map((action) => action.tool), ['plugin.call']);
    assert.deepEqual(waiting.data.approvedActionHashes, []);
    assert.deepEqual(executed, []);
    await assert.rejects(tasks.control(principal.id, childId, 'resume', ['0'.repeat(64)], principal), hasCode('invalid_approval'));
    await assert.rejects(tasks.control(principal.id, childId, 'resume', [], principal), hasCode('approval_required'));
    assert.deepEqual(executed, []);

    await tasks.control(principal.id, childId, 'resume', waiting.data.pendingActions.map((action) => action.hash), principal);
    await tasks.drain();
    assert.equal((await store.get<Task>('task', childId, principal.id))?.data.state, 'completed');
    assert.deepEqual(executed, ['plugin.call']);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('child side effects list each changed workspace path once and every confirmed external action', async () => {
  const h = harness((task) => isChild(task) ? [
    { tool: 'workspace.write', sideEffect: 'write', arguments: { path: './notes/../b.txt' } },
    { tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'b.txt' } },
    { tool: 'workspace.patch', sideEffect: 'write', arguments: { patch: '...' }, result: { content: JSON.stringify({ path: 'src\\a.ts' }) } },
    { tool: 'workspace.restore', sideEffect: 'write', arguments: { checkpointId: 'c1' }, result: { content: JSON.stringify({ restored: 'c.txt' }) } },
    { tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'rejected.txt' }, failed: true },
    { tool: 'workspace.read', arguments: { path: 'only-read.txt' } },
    { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm run build', shell: '/bin/sh' } },
    { tool: 'mac.app.focus', sideEffect: 'write', arguments: { bundleId: 'com.example.editor' } },
    { tool: 'plugin.call', sideEffect: 'external', arguments: { to: 'list' }, failed: true },
  ] : []);
  try {
    const { planId, childIds } = await h.start();
    await h.service.drain();
    await h.store.create('event', 'someone-else', {
      taskId: childIds[0]!,
      sequence: 900,
      type: 'tool_dispatched',
      payload: { type: 'tool_dispatched', actionHash: 'foreign', sideEffect: 'write', toolCall: { id: 'foreign', name: 'workspace.write', arguments: { path: 'foreign.txt' } } },
      at: new Date().toISOString(),
    });
    await h.store.create('event', 'someone-else', {
      taskId: childIds[0]!,
      sequence: 901,
      type: 'tool_result',
      payload: { type: 'tool_result', actionHash: 'foreign', toolCallId: 'foreign', outcome: 'confirmed', isError: false },
      at: new Date().toISOString(),
    });

    const effects = await h.coordinator.childSideEffects(principal.id, planId);

    assert.deepEqual(effects.changes.map((change) => [change.path, change.tool]), [
      ['b.txt', 'workspace.write'],
      ['c.txt', 'workspace.restore'],
      ['src/a.ts', 'workspace.patch'],
    ]);
    assert.equal(effects.changes[0]!.actionHash, `${childIds[0]}:1:workspace.write`);
    assert.equal(Number.isNaN(Date.parse(effects.changes[0]!.at)), false);
    assert.deepEqual(effects.externalActions, [
      { taskId: childIds[0], tool: 'terminal.run', actionHash: `${childIds[0]}:6:terminal.run`, arguments: { command: 'npm run build', shell: '/bin/sh' } },
      { taskId: childIds[0], tool: 'mac.app.focus', actionHash: `${childIds[0]}:7:mac.app.focus`, arguments: { bundleId: 'com.example.editor' } },
    ]);
  } finally {
    await h.close();
  }
});

test('a workspace change whose path was not reported is still listed, and read-only children list nothing', async () => {
  const h = harness((task) => task.data.orchestration?.childKey === 'writer'
    ? [{ tool: 'workspace.patch', sideEffect: 'write', arguments: { patch: '...' } }]
    : isChild(task) ? [{ tool: 'workspace.read', arguments: { path: 'a.txt' } }] : []);
  try {
    const first = await h.start(['reader']);
    await h.service.drain();
    assert.deepEqual(await h.coordinator.childSideEffects(principal.id, first.planId), { changes: [], externalActions: [] });

    const second = await h.start(['writer']);
    await h.service.drain();
    const effects = await h.coordinator.childSideEffects(principal.id, second.planId);
    assert.deepEqual(effects.changes.map((change) => [change.path, change.tool]), [[undefined, 'workspace.patch']]);
    await assert.rejects(h.coordinator.childSideEffects(principal.id, 'missing-plan'), hasCode('not_found'));
  } finally {
    await h.close();
  }
});
```

How the helpers work, because every later task relies on them: `harness(steps)` builds a `TaskService` whose runner replays the scripted tool events returned by `steps(task)` and, for a parent in its integration phase, calls `coordinator.verifyIntegration` before returning — that is, while the parent task is still `running`. An error from that call is collected in `errors` and rethrown, so the task ends the way `TaskService` maps the error. `start()` creates a conversation in `act` mode, enqueues the parent and prepares one child per key (`coordinator.prepare` puts the parent straight into `waiting_for_children`). `integrate(h, planId)` runs the children, queues the parent's integration and runs it. The scripted action hash of step `index` of a task is `` `${taskId}:${index}:${tool}` ``.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/delegation-verification.test.ts`

Expected: the approval-gate test passes (it pins existing behaviour), the two inventory tests fail because the method does not exist yet:

```
✔ a child agent stops for exact approval before an external tool runs
✖ child side effects list each changed workspace path once and every confirmed external action
✖ a workspace change whose path was not reported is still listed, and read-only children list nothing
ℹ tests 3
ℹ pass 1
ℹ fail 2

✖ child side effects list each changed workspace path once and every confirmed external action
  TypeError [Error]: h.coordinator.childSideEffects is not a function
```

If the first test fails instead of passing, stop and report it: child actions are then not individually approved and the evidence rule of this plan must not be implemented.

- [ ] **Step 3: Write minimal implementation**

All edits are in `src/agents/coordinator.ts`.

`src/agents/coordinator.ts`, edit 1 of 7 — the end of `interface OrchestrationResults` (lines 60-67): add three exported interfaces after it. Replace:

```ts
  verificationRequired: boolean;
}
```

with:

```ts
  verificationRequired: boolean;
}

export interface ChildWorkspaceChange {
  path?: string;
  tool: string;
  actionHash: string;
  at: string;
}

export interface ChildExternalAction {
  taskId: string;
  tool: string;
  actionHash: string;
  arguments: Record<string, unknown>;
}

export interface ChildSideEffects {
  changes: ChildWorkspaceChange[];
  externalActions: ChildExternalAction[];
}
```

`src/agents/coordinator.ts`, edit 2 of 7 — `interface ConfirmedAction` (lines 87-93): remember which task acted and when the result was confirmed. Replace:

```ts
interface ConfirmedAction {
  actionHash: string;
  tool: string;
  arguments: Record<string, unknown>;
  sideEffect?: string;
  result?: unknown;
}
```

with:

```ts
interface ConfirmedAction {
  taskId: string;
  actionHash: string;
  tool: string;
  arguments: Record<string, unknown>;
  sideEffect?: string;
  result?: unknown;
  at: string;
}
```

`src/agents/coordinator.ts`, edit 3 of 7 — the module constants (line 97): name the three tools that change workspace files. Replace:

```ts
const planKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
```

with:

```ts
const planKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const workspaceMutationTools = new Set(['workspace.write', 'workspace.patch', 'workspace.restore']);
```

`src/agents/coordinator.ts`, edit 4 of 7 — inside `function confirmedActions` (lines 140-149): fill the two new fields. Replace:

```ts
      dispatched.set(key, {
        actionHash: key,
        tool: payload.toolCall.name,
        arguments: payload.toolCall.arguments ?? {},
        sideEffect: payload.sideEffect,
      });
    } else if (event.data.type === 'tool_result' && payload.outcome === 'confirmed' && !payload.isError) {
      const action = dispatched.get(key);
      if (action) confirmed.push({ ...action, result: payload.result });
    }
```

with:

```ts
      dispatched.set(key, {
        taskId: event.data.taskId,
        actionHash: key,
        tool: payload.toolCall.name,
        arguments: payload.toolCall.arguments ?? {},
        sideEffect: payload.sideEffect,
        at: event.data.at,
      });
    } else if (event.data.type === 'tool_result' && payload.outcome === 'confirmed' && !payload.isError) {
      const action = dispatched.get(key);
      if (action) confirmed.push({ ...action, result: payload.result, at: event.data.at });
    }
```

`src/agents/coordinator.ts`, edit 5 of 7 — inside `function resultPath` (lines 165-167): `workspace.restore` reports its path as `restored`, not `path`. Replace:

```ts
  try {
    return normalizedWorkspacePath((JSON.parse(content) as { path?: unknown }).path);
  } catch {
```

with:

```ts
  try {
    const parsed = JSON.parse(content) as { path?: unknown; restored?: unknown };
    return normalizedWorkspacePath(parsed.path) ?? normalizedWorkspacePath(parsed.restored);
  } catch {
```

`src/agents/coordinator.ts`, edit 6 of 7 — immediately above `function validateRequest` (line 187): add two module-private functions. Replace:

```ts
function validateRequest(request: PrepareChildrenRequest): ChildStrategy {
```

with:

```ts
function collectChildSideEffects(events: Array<Entity<TaskEvent>>, childIds: string[]): ChildSideEffects {
  const children = new Set(childIds);
  const changes = new Map<string, ChildWorkspaceChange>();
  const externalActions: ChildExternalAction[] = [];
  for (const action of confirmedActions(events, (event) => children.has(event.data.taskId))) {
    if (action.sideEffect !== 'write' && action.sideEffect !== 'external') continue;
    if (!workspaceMutationTools.has(action.tool)) {
      externalActions.push({
        taskId: action.taskId,
        tool: action.tool,
        actionHash: action.actionHash,
        arguments: action.arguments,
      });
      continue;
    }
    const resource = changedWorkspacePath(action);
    const key = resource ?? `\0${action.actionHash}`;
    const previous = changes.get(key);
    if (previous && previous.at > action.at) continue;
    changes.set(key, {
      ...(resource ? { path: resource } : {}),
      tool: action.tool,
      actionHash: action.actionHash,
      at: action.at,
    });
  }
  return {
    changes: [...changes.values()].sort((left, right) => childChangeLabel(left).localeCompare(childChangeLabel(right))),
    externalActions,
  };
}

export function childChangeLabel(change: ChildWorkspaceChange): string {
  return change.path ?? `${change.tool} (path not reported)`;
}

function validateRequest(request: PrepareChildrenRequest): ChildStrategy {
```

`src/agents/coordinator.ts`, edit 7 of 7 — inside `class AgentCoordinator`, immediately above `public async verifyIntegration` (line 399): add the public method. Replace:

```ts
  public async verifyIntegration(ownerId: string, planId: string, _claimedEvidence?: string)
```

with:

```ts
  public async childSideEffects(ownerId: string, planId: string): Promise<ChildSideEffects> {
    const plan = await this.requirePlan(ownerId, planId);
    return collectChildSideEffects(await this.store.scan<TaskEvent>('event', ownerId), plan.data.childIds);
  }

  public async verifyIntegration(ownerId: string, planId: string, _claimedEvidence?: string)
```

Notes on the code: `confirmedActions` already returns only actions whose `tool_result` has `outcome: 'confirmed'` and `isError` false, so a rejected write or a failed command never appears. The `at` of the dispatch is overwritten by the `at` of the confirmed result. An unreported path is keyed by `\0` plus the action hash so that two such changes stay separate entries.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/delegation-verification.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts`

Expected: no type errors; every test passes:

```
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

(19 is 9 + 7 existing tests plus the 3 new ones as of commit `17d571f`; earlier plans may have added tests to the two existing files, in which case the total is higher and `fail` is still 0.)

- [ ] **Step 5: Commit**

```bash
git add src/agents/coordinator.ts test/delegation-verification.test.ts
git commit -m "實現：彙整子任務已確認的工作區變更與外部動作"
```

---

### Task 2: Evidence rule and `verification_failed` inside the parent run

`verifyIntegration` today refuses any parent that is not already `completed`, fails with `verification_required` without saying what is missing, and treats every confirmed child terminal, plugin, browser, Mac app or export action as unverifiable. This task makes it callable while the parent is `running`, applies the evidence rule from the header, names the missing paths, and records the outcome on the parent as `passed` or `failed`.

**Files:**
- Modify: `src/domain.ts` (`TaskOrchestration.verification`, line 44)
- Modify: `src/agents/coordinator.ts` (new functions directly below `verifiesWorkspacePath`, lines 178-185; `verifyIntegration`, `integrationEvidence`, `markParentVerified`, lines 399-444)
- Modify: `src/runtime-adapter.ts` (`reconcileAgentTasks`, line 346 only)
- Modify: `test/agents-runtime.test.ts` (line 300 only)
- Test: `test/delegation-verification.test.ts`

**Interfaces:**
- Consumes (Task 1): `collectChildSideEffects(events, childIds): ChildSideEffects`, `childChangeLabel(change): string`, `ChildWorkspaceChange { path?, tool, actionHash, at }`, `ConfirmedAction` with `taskId` and `at`; test helpers `principal`, `Step`, `harness(steps, options?)`, `integrate(h, planId)`, `isChild(task)`, `hasCode(code)`.
- Consumes (existing, unchanged): `confirmedActions(events, include)`, `verifiesWorkspacePath(action, resource)`, `changedWorkspacePath(action)`, `AgentCoordinator.changeTask`, `changePlan`, `requirePlan`, `requireTask`.
- Produces:
  - `TaskOrchestration.verification: 'pending' | 'passed' | 'failed'`.
  - `AgentCoordinator.verifyIntegration(ownerId: string, planId: string, _claimedEvidence?: string): Promise<Entity<OrchestrationPlan>>` — signature unchanged. Precondition: plan state `integrating` or `completed` and parent state `running` or `completed`, otherwise `DomainError('integration_incomplete', …, 409)`. Pass: plan becomes `completed` with `verification { at, evidence }`, parent `orchestration.verification` becomes `'passed'`. Fail: throws `DomainError('verification_failed', message, 409)`; the plan stays `integrating`; the parent's `orchestration.verification` becomes `'failed'` only if the parent is `running` (a parent already stored as `completed` is not touched).
  - The failure message: `Delegated work is unverified. Before its final answer the parent must read each child-changed workspace path with workspace.read or run a passing test command in the workspace. Not verified: <at most 20 labels, comma separated>[ and N more]`, cut at 2000 characters.
  - The evidence texts: `No confirmed child side effects required resource verification.` (unchanged); `No child workspace changes required verification. Confirmed external child actions, individually approved and not re-verified: <tool> (<actionHash>), …`; `Parent verified child resources: <path> (<actionHash>), …` optionally followed by `. Confirmed external child actions, individually approved and not re-verified: …`.
  - The error code `verification_required` no longer exists anywhere in `src/`.
  - Test helpers used by later tasks: `wrote(path)`, `read(path)`, `ran(command, failed?)`.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/delegation-verification.test.ts`:

```ts

const wrote = (path: string): Step => ({ tool: 'workspace.write', sideEffect: 'write', arguments: { path } });
const read = (path: string): Step => ({ tool: 'workspace.read', arguments: { path } });
const ran = (command: string, failed = false): Step => ({
  tool: 'terminal.run', sideEffect: 'external', arguments: { command, shell: '/bin/sh' }, failed,
});

test('verification passes inside the parent run when no child changed the workspace', async () => {
  const h = harness((task) => isChild(task) ? [read('notes.txt')] : []);
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);

    assert.deepEqual(h.errors, []);
    const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'completed', parent.data.error);
    assert.equal(parent.data.orchestration?.verification, 'passed');
    const plan = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(plan.data.state, 'completed');
    assert.equal(plan.data.verification?.evidence, 'No confirmed child side effects required resource verification.');
  } finally {
    await h.close();
  }
});

test('an unread child change fails the parent and the message names only the missing path', async () => {
  const h = harness((task) => isChild(task) ? [wrote('a.txt'), wrote('docs/b.txt')] : [read('./a.txt')]);
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);

    assert.equal(h.errors.length, 1);
    const error = h.errors[0] as { code: string; statusCode: number; message: string };
    assert.equal(error.code, 'verification_failed');
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Not verified: docs\/b\.txt$/);
    assert.doesNotMatch(error.message, /a\.txt/);
    const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'failed');
    assert.equal(parent.data.error, error.message);
    assert.equal(parent.data.orchestration?.verification, 'failed');
    assert.equal((await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'integrating');
  } finally {
    await h.close();
  }
});

test('a passing test command verifies every child change; other commands verify only the path they name', async () => {
  const cases: Array<{ parent: Step[]; missing: string[] }> = [
    { parent: [ran('npm test')], missing: [] },
    { parent: [ran('cd packages/core && CI=1 npm run test:unit -- --bail')], missing: [] },
    { parent: [ran('swift test')], missing: [] },
    { parent: [ran('npm test 2>&1')], missing: [] },
    { parent: [ran('npm test\n')], missing: [] },
    { parent: [ran('npm test\necho done')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('npm test', true)], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('npm test || true')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('npm test; echo done')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('npm test | tee log.txt')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('npm test 2>&1 | tail -n 20')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('npm test 2>&1 & echo started')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('echo npm test')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('npm run build')], missing: ['a.txt', 'b.txt'] },
    { parent: [ran('cat b.txt')], missing: ['a.txt'] },
    { parent: [ran('test -s ./a.txt'), ran('git diff -- b.txt')], missing: [] },
    { parent: [ran('echo a.txt b.txt')], missing: ['a.txt', 'b.txt'] },
    { parent: [read('a.txt'), read('b.txt')], missing: [] },
    { parent: [{ ...read('a.txt'), failed: true }, read('b.txt')], missing: ['a.txt'] },
  ];
  for (const { parent, missing } of cases) {
    const label = JSON.stringify(parent.map((step) => step.arguments));
    const h = harness((task) => isChild(task) ? [wrote('a.txt'), wrote('b.txt')] : parent);
    try {
      const { parentId, planId } = await h.start();
      await integrate(h, planId);
      const stored = (await h.store.get<Task>('task', parentId, principal.id))!;
      if (missing.length === 0) {
        assert.equal(stored.data.state, 'completed', `${label}: ${stored.data.error}`);
        assert.equal(stored.data.orchestration?.verification, 'passed', label);
        const evidence = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!.data.verification!.evidence;
        assert.match(evidence, /^Parent verified child resources: a\.txt \([^)]+\), b\.txt \([^)]+\)$/, label);
      } else {
        assert.equal(stored.data.state, 'failed', label);
        assert.equal(stored.data.error?.endsWith(`Not verified: ${missing.join(', ')}`), true, `${label}: ${stored.data.error}`);
      }
    } finally {
      await h.close();
    }
  }
});

test('confirmed external child actions are recorded as evidence and never fail the parent', async () => {
  const external: Step[] = [
    ran('npm run build'),
    { tool: 'plugin.call', sideEffect: 'external', arguments: { pluginId: 'mail', tool: 'send' } },
    { tool: 'browser.click', sideEffect: 'external', arguments: { selector: '#submit' } },
    { tool: 'mac.app.window', sideEffect: 'write', arguments: { bundleId: 'com.example.editor' } },
    { tool: 'workspace.export', sideEffect: 'external', arguments: { path: 'report.pdf' } },
  ];
  const onlyExternal = harness((task) => isChild(task) ? external : []);
  try {
    const { parentId, planId, childIds } = await onlyExternal.start();
    await integrate(onlyExternal, planId);
    const parent = (await onlyExternal.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'completed', parent.data.error);
    assert.equal(parent.data.orchestration?.verification, 'passed');
    const evidence = (await onlyExternal.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!.data.verification!.evidence;
    assert.equal(evidence, 'No child workspace changes required verification. '
      + 'Confirmed external child actions, individually approved and not re-verified: '
      + ['terminal.run', 'plugin.call', 'browser.click', 'mac.app.window', 'workspace.export']
        .map((tool, index) => `${tool} (${childIds[0]}:${index}:${tool})`).join(', '));
  } finally {
    await onlyExternal.close();
  }

  const mixed = harness((task) => isChild(task) ? [wrote('result.txt'), ran('npm run build')] : [read('result.txt')]);
  try {
    const { parentId, planId, childIds } = await mixed.start();
    await integrate(mixed, planId);
    assert.equal((await mixed.store.get<Task>('task', parentId, principal.id))?.data.state, 'completed');
    assert.equal(
      (await mixed.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!.data.verification!.evidence,
      `Parent verified child resources: result.txt (${childIds[0]}:0:workspace.write). `
        + `Confirmed external child actions, individually approved and not re-verified: terminal.run (${childIds[0]}:1:terminal.run)`,
    );
  } finally {
    await mixed.close();
  }
});

test('a rejected child write needs no evidence and an unreported path can only be covered by a test run', async () => {
  const rejected = harness((task) => isChild(task) ? [{ ...wrote('never.txt'), failed: true }] : []);
  try {
    const { parentId, planId } = await rejected.start();
    await integrate(rejected, planId);
    assert.equal((await rejected.store.get<Task>('task', parentId, principal.id))?.data.state, 'completed');
  } finally {
    await rejected.close();
  }

  const patch: Step = { tool: 'workspace.patch', sideEffect: 'write', arguments: { patch: '...' } };
  const unreported = harness((task) => isChild(task) ? [patch] : [read('guess.txt')]);
  try {
    const { parentId, planId } = await unreported.start();
    await integrate(unreported, planId);
    const parent = (await unreported.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'failed');
    assert.match(parent.data.error!, /Not verified: workspace\.patch \(path not reported\)$/);
  } finally {
    await unreported.close();
  }

  const tested = harness((task) => isChild(task) ? [patch] : [ran('pytest')]);
  try {
    const { parentId, planId } = await tested.start();
    await integrate(tested, planId);
    assert.equal((await tested.store.get<Task>('task', parentId, principal.id))?.data.state, 'completed');
  } finally {
    await tested.close();
  }
});

test('more than twenty unverified paths are counted instead of listed', async () => {
  const paths = Array.from({ length: 25 }, (_, index) => `file-${String(index).padStart(2, '0')}.txt`);
  const h = harness((task) => isChild(task) ? paths.map(wrote) : []);
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);
    const error = (await h.store.get<Task>('task', parentId, principal.id))!.data.error!;
    assert.match(error, /file-00\.txt, .*file-19\.txt and 5 more$/);
    assert.doesNotMatch(error, /file-20\.txt/);
    assert.equal(error.length <= 2_000, true);
  } finally {
    await h.close();
  }
});

test('verification is idempotent after a pass and refuses a parent that is not integrating', async () => {
  const h = harness((task) => isChild(task) ? [wrote('result.txt')] : [read('result.txt')]);
  try {
    const { parentId, planId } = await h.start();
    await assert.rejects(h.coordinator.verifyIntegration(principal.id, planId), hasCode('integration_incomplete'));
    await h.service.drain();
    await h.coordinator.queueIntegration(principal.id, planId);
    await assert.rejects(h.coordinator.verifyIntegration(principal.id, planId), hasCode('integration_incomplete'));
    await h.service.drain();

    const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
    const plan = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(parent.data.state, 'completed', parent.data.error);
    const replay = await h.coordinator.verifyIntegration(principal.id, planId);
    assert.equal(replay.revision, plan.revision);
    assert.equal((await h.store.get<Task>('task', parentId, principal.id))?.revision, parent.revision);
  } finally {
    await h.close();
  }
});

test('a parent stored as completed with pending verification is left as stored when a late check fails', async () => {
  const h = harness((task) => isChild(task) ? [wrote('result.txt')] : [], { verifyInRun: false });
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);
    const legacy = (await h.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(legacy.data.state, 'completed');
    assert.equal(legacy.data.orchestration?.verification, 'pending');

    await assert.rejects(h.coordinator.verifyIntegration(principal.id, planId), hasCode('verification_failed'));

    const after = (await h.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(after.revision, legacy.revision);
    assert.equal(after.data.state, 'completed');
    assert.equal(after.data.orchestration?.verification, 'pending');
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/delegation-verification.test.ts`

Expected: the three tests from Task 1 pass and all eight new tests fail. Seven fail because `verifyIntegration` refuses a running parent; the last one (`a parent stored as completed with pending verification is left as stored when a late check fails`) fails because the late check still throws the old code `verification_required`:

```
ℹ tests 11
ℹ pass 3
ℹ fail 8

✖ verification passes inside the parent run when no child changed the workspace
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + [
  +   DomainError: Parent integration must complete before verification
  ...
  +     code: 'integration_incomplete',
✖ an unread child change fails the parent and the message names only the missing path
  + 'integration_incomplete'
  - 'verification_failed'
```

- [ ] **Step 3: Write minimal implementation**

`src/domain.ts`, edit 1 of 1 — `interface TaskOrchestration` (line 44). Replace:

```ts
  verification: 'pending' | 'passed';
```

with:

```ts
  verification: 'pending' | 'passed' | 'failed';
```

`src/agents/coordinator.ts`, edit 1 of 2 — immediately above `function collectChildSideEffects` (added by Task 1, directly below `function verifiesWorkspacePath`): add the test-command rule and the failure message. Replace:

```ts
function collectChildSideEffects(events: Array<Entity<TaskEvent>>, childIds: string[]): ChildSideEffects {
```

with:

```ts
const testRunnerCommand = /^\s*([A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(npm\s+(test|run\s+test)|swift\s+test|pytest|cargo\s+test)\b/;

function runsWorkspaceTests(action: ConfirmedAction): boolean {
  if (action.tool !== 'terminal.run' || typeof action.arguments.command !== 'string') return false;
  const segments = action.arguments.command.trim().split('&&');
  return segments.every((segment) => !/[;|&\n]/.test(segment.replace(/\d*>&\d+/g, '')))
    && segments.some((segment) => testRunnerCommand.test(segment));
}

function verifiesChange(check: ConfirmedAction, change: ChildWorkspaceChange): boolean {
  return runsWorkspaceTests(check) || (change.path !== undefined && verifiesWorkspacePath(check, change.path));
}

function verificationFailureMessage(missing: ChildWorkspaceChange[]): string {
  const labels = missing.map(childChangeLabel);
  const more = labels.length > 20 ? ` and ${labels.length - 20} more` : '';
  return `Delegated work is unverified. Before its final answer the parent must read each child-changed workspace path with workspace.read or run a passing test command in the workspace. Not verified: ${labels.slice(0, 20).join(', ')}${more}`.slice(0, 2_000);
}

function collectChildSideEffects(events: Array<Entity<TaskEvent>>, childIds: string[]): ChildSideEffects {
```

`src/agents/coordinator.ts`, edit 2 of 2 — `verifyIntegration`, `integrationEvidence` and `markParentVerified` (lines 399-444): replace all three methods. Replace:

```ts
  public async verifyIntegration(ownerId: string, planId: string, _claimedEvidence?: string): Promise<Entity<OrchestrationPlan>> {
    const plan = await this.requirePlan(ownerId, planId);
    const parent = await this.requireTask(ownerId, plan.data.parentTaskId);
    if (!['integrating', 'completed'].includes(plan.data.state) || parent.data.state !== 'completed') {
      throw new DomainError('integration_incomplete', 'Parent integration must complete before verification', 409);
    }
    if (plan.data.state === 'completed' && plan.data.verification) {
      await this.markParentVerified(ownerId, parent.id);
      return plan;
    }
    const evidence = await this.integrationEvidence(ownerId, plan);
    const verified = await this.changePlan(ownerId, plan.id, (current) => current.state === 'completed'
      ? current
      : { ...current, state: 'completed', verification: { at: new Date(this.now()).toISOString(), evidence } });
    await this.markParentVerified(ownerId, parent.id);
    return verified;
  }

  private async integrationEvidence(ownerId: string, plan: Entity<OrchestrationPlan>): Promise<string> {
    const events = await this.store.scan<TaskEvent>('event', ownerId);
    const childIds = new Set(plan.data.childIds);
    const mutations = confirmedActions(events, (event) => childIds.has(event.data.taskId))
      .filter((action) => action.sideEffect === 'write' || action.sideEffect === 'external');
    if (mutations.length === 0) return 'No confirmed child side effects required resource verification.';
    const resources = new Map<string, string>();
    for (const mutation of mutations) {
      const resource = changedWorkspacePath(mutation);
      if (!resource) {
        throw new DomainError('verification_required', 'A confirmed child side effect has no resource evidence for parent verification', 409);
      }
      resources.set(resource, mutation.actionHash);
    }
    const checks = confirmedActions(events, (event) => event.data.taskId === plan.data.parentTaskId
      && event.data.at >= plan.updatedAt);
    const verified = [...resources.entries()].filter(([resource]) => checks.some((check) => verifiesWorkspacePath(check, resource)));
    if (verified.length !== resources.size) {
      throw new DomainError('verification_required', 'Parent verification must inspect or test every confirmed child resource', 409);
    }
    return `Parent verified child resources: ${verified.map(([resource, actionHash]) => `${resource} (${actionHash})`).join(', ').slice(0, 3_900)}`;
  }

  private async markParentVerified(ownerId: string, parentId: string): Promise<void> {
    await this.changeTask(ownerId, parentId, (task) => task.orchestration
      ? { ...task, orchestration: { ...task.orchestration, verification: 'passed' } }
      : task);
  }
```

with:

```ts
  public async verifyIntegration(ownerId: string, planId: string, _claimedEvidence?: string): Promise<Entity<OrchestrationPlan>> {
    const plan = await this.requirePlan(ownerId, planId);
    const parent = await this.requireTask(ownerId, plan.data.parentTaskId);
    if (!['integrating', 'completed'].includes(plan.data.state) || !['running', 'completed'].includes(parent.data.state)) {
      throw new DomainError('integration_incomplete', 'Parent integration must be running or complete before verification', 409);
    }
    if (plan.data.state === 'completed' && plan.data.verification) {
      await this.markParentVerification(ownerId, parent.id, 'passed');
      return plan;
    }
    let evidence: string;
    try {
      evidence = await this.integrationEvidence(ownerId, plan);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'verification_failed' && parent.data.state === 'running') {
        await this.markParentVerification(ownerId, parent.id, 'failed');
      }
      throw error;
    }
    const verified = await this.changePlan(ownerId, plan.id, (current) => current.state === 'completed'
      ? current
      : { ...current, state: 'completed', verification: { at: new Date(this.now()).toISOString(), evidence } });
    await this.markParentVerification(ownerId, parent.id, 'passed');
    return verified;
  }

  private async integrationEvidence(ownerId: string, plan: Entity<OrchestrationPlan>): Promise<string> {
    const events = await this.store.scan<TaskEvent>('event', ownerId);
    const effects = collectChildSideEffects(events, plan.data.childIds);
    const recorded = effects.externalActions.length
      ? `Confirmed external child actions, individually approved and not re-verified: ${effects.externalActions.map((action) => `${action.tool} (${action.actionHash})`).join(', ')}`.slice(0, 1_000)
      : '';
    if (effects.changes.length === 0) {
      return recorded
        ? `No child workspace changes required verification. ${recorded}`
        : 'No confirmed child side effects required resource verification.';
    }
    const checks = confirmedActions(events, (event) => event.data.taskId === plan.data.parentTaskId
      && event.data.at >= plan.updatedAt);
    const missing = effects.changes.filter((change) => !checks.some((check) => verifiesChange(check, change)));
    if (missing.length > 0) {
      throw new DomainError('verification_failed', verificationFailureMessage(missing), 409);
    }
    const resources = effects.changes.map((change) => `${childChangeLabel(change)} (${change.actionHash})`).join(', ');
    return `${`Parent verified child resources: ${resources}`.slice(0, 2_900)}${recorded ? `. ${recorded}` : ''}`;
  }

  private async markParentVerification(ownerId: string, parentId: string, verification: 'passed' | 'failed'): Promise<void> {
    await this.changeTask(ownerId, parentId, (task) => !task.orchestration || task.orchestration.verification === verification
      ? task
      : { ...task, orchestration: { ...task.orchestration, verification } });
  }
```

`src/runtime-adapter.ts`, edit 1 of 1 — the last branch of `reconcileAgentTasks` (line 346): the reconciler still verifies until Task 7 removes this branch, so it must swallow the renamed code. Replace:

```ts
        if (!(error instanceof DomainError && error.code === 'verification_required')) throw error;
```

with:

```ts
        if (!(error instanceof DomainError && error.code === 'verification_failed')) throw error;
```

`test/agents-runtime.test.ts`, edit 1 of 1 — the test `automatic integration verification requires a correlated inspection after child side effects` (line 300): the expected code. Replace:

```ts
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'verification_required',
```

with:

```ts
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'verification_failed',
```

Notes on the code:

- `runsWorkspaceTests` accepts a test command only when the whole command is a chain of `&&`-joined segments with no `;`, `|`, single `&` or newline. In such a chain exit code zero means every segment succeeded, so `npm test || true`, `npm test; echo done` and `npm test | tee log` do not count. A segment may start with environment assignments (`CI=1 npm test`). Descriptor redirections of the form `2>&1` are removed before the separator check: models append them routinely, they do not change the exit status, and without this a parent that really ran the tests would fail for good. What is left after the removal is still checked, so `npm test 2>&1 | tail -n 20` and `npm test 2>&1 & echo started` do not count. The command is trimmed first: a model that ends its command with a newline (`npm test\n`) did run the tests, while a newline between two commands (`npm test\necho done`) is still a separator and does not count.
- Known limit, accepted: the rule reads the command text and does not parse shell quoting, so a quoted `&&` followed by a test command inside another command's argument (`echo "x && npm test"`) is accepted. The parent runs under the same principal as the check, so this is a guard against forgetting to verify, not a security boundary. Do not add a shell parser.
- `terminal.run` reports a non-zero exit, a timeout or an abort as `isError: true`, which the runtime records as `outcome: 'failed'`; such a run never reaches `verifiesChange` because `confirmedActions` drops it.
- The parent check window still starts at `plan.updatedAt` in this task. Task 3 replaces that comparison.
- `markParentVerification` returns the task object unchanged when the value is already stored, and `changeTask` then performs no write. That is what makes a replay leave the parent's revision alone.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/delegation-verification.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts`

Expected: no type errors; every test passes (27 as of commit `17d571f`: 16 existing plus 11 in the new file):

```
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

Then confirm the old code is gone: `grep -rn "verification_required" src test` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/domain.ts src/agents/coordinator.ts src/runtime-adapter.ts test/agents-runtime.test.ts test/delegation-verification.test.ts
git commit -m "修復：委派驗證在整合執行內完成並指出未檢查的路徑"
```

---

### Task 3: Order evidence by event time, not by the plan row

After Task 2 a parent check counts only if its event time is at or after `plan.updatedAt`. The two values come from different clocks: event times are stamped by `TaskService` (application clock, or the `now` option), while `updatedAt` is stamped by the store (`NOW()` on the database host in `PostgresStore`). Both directions of skew were reproduced against commit `17d571f` plus Tasks 1-2: with the application clock behind the store, a parent that did read the child's file fails verification; with it ahead, a read the parent made before the child changed the file is accepted. Because a failed verification is now terminal, the comparison is replaced by one between two event times from the same clock: the parent's check must be at or after the child's change of that path.

**Files:**
- Modify: `src/agents/coordinator.ts` (`integrationEvidence`, lines 417-438 as of commit `17d571f`, as rewritten by Task 2)
- Test: `test/delegation-verification.test.ts`

**Interfaces:**
- Consumes (Task 1): `ChildWorkspaceChange.at` (time of the child's confirmed change), `ConfirmedAction.at` (time of the parent's confirmed check). (Task 2): `verifiesChange(check, change)`; test helpers `harness(steps, options?)` (`options.now` is the `TaskServiceOptions.now` clock), `integrate(h, planId)`, `wrote(path)`, `read(path)`, `isChild(task)`, `principal`.
- Produces: no new names. `integrationEvidence` no longer reads `plan.updatedAt`; pausing, resuming or otherwise rewriting the plan row no longer moves the evidence window.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/delegation-verification.test.ts`:

```ts

test('a parent check counts when the application clock is behind the store clock', async () => {
  const h = harness((task) => isChild(task) ? [wrote('result.txt')] : [read('result.txt')], {
    now: () => Date.now() - 60_000,
  });
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);
    const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'completed', parent.data.error);
    assert.equal(parent.data.orchestration?.verification, 'passed');
  } finally {
    await h.close();
  }
});

test('a parent check made before the child changed the path does not count', async () => {
  for (const rereads of [false, true]) {
    let clock = Date.now() + 600_000;
    const h = harness((task) => isChild(task) ? [wrote('result.txt')] : rereads ? [read('result.txt')] : [], {
      now: () => clock,
    });
    try {
      const { parentId, planId } = await h.start();
      await h.store.create('event', principal.id, {
        taskId: parentId,
        sequence: 50,
        type: 'tool_dispatched',
        payload: {
          type: 'tool_dispatched', actionHash: 'early-read', sideEffect: 'read',
          toolCall: { id: 'early-read', name: 'workspace.read', arguments: { path: 'result.txt' } },
        },
        at: new Date(clock).toISOString(),
      }, `${parentId}:early-read-dispatched`);
      await h.store.create('event', principal.id, {
        taskId: parentId,
        sequence: 51,
        type: 'tool_result',
        payload: { type: 'tool_result', actionHash: 'early-read', toolCallId: 'early-read', outcome: 'confirmed', isError: false },
        at: new Date(clock).toISOString(),
      }, `${parentId}:early-read-result`);
      clock += 1_000;
      await h.service.drain();
      clock += 1_000;
      await h.coordinator.queueIntegration(principal.id, planId);
      await h.service.drain();

      const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
      if (rereads) {
        assert.equal(parent.data.state, 'completed', parent.data.error);
      } else {
        assert.equal(parent.data.state, 'failed');
        assert.match(parent.data.error!, /Not verified: result\.txt$/);
      }
    } finally {
      await h.close();
    }
  }
});
```

The second test writes a parent `workspace.read` of `result.txt` by hand before the child runs (sequence numbers 50 and 51 are free: `TaskService` continues after the highest stored sequence), then moves the clock forward before the child changes the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/delegation-verification.test.ts`

Expected: both new tests fail, one in each direction of clock skew:

```
ℹ tests 13
ℹ pass 11
ℹ fail 2

✖ a parent check counts when the application clock is behind the store clock
  AssertionError [ERR_ASSERTION]: Delegated work is unverified. Before its final answer the parent must read each child-changed workspace path with workspace.read or run a passing test command in the workspace. Not verified: result.txt
  + 'failed'
  - 'completed'
✖ a parent check made before the child changed the path does not count
  + 'completed'
  - 'failed'
```

- [ ] **Step 3: Write minimal implementation**

`src/agents/coordinator.ts`, edit 1 of 1 — inside `integrationEvidence` (as rewritten by Task 2): compare each parent check with the change it is meant to verify instead of with the plan row. Replace:

```ts
    const checks = confirmedActions(events, (event) => event.data.taskId === plan.data.parentTaskId
      && event.data.at >= plan.updatedAt);
    const missing = effects.changes.filter((change) => !checks.some((check) => verifiesChange(check, change)));
```

with:

```ts
    const checks = confirmedActions(events, (event) => event.data.taskId === plan.data.parentTaskId);
    const missing = effects.changes.filter((change) => !checks.some((check) => check.at >= change.at
      && verifiesChange(check, change)));
```

Both times are ISO-8601 strings produced by `new Date(...).toISOString()` in `TaskService`, so string comparison orders them correctly. Equal times count as verified.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/delegation-verification.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts`

Expected: no type errors; every test passes (29 as of commit `17d571f`: 16 existing plus 13 in the new file):

```
ℹ tests 29
ℹ pass 29
ℹ fail 0
```

- [ ] **Step 5: Commit**

```bash
git add src/agents/coordinator.ts test/delegation-verification.test.ts
git commit -m "修復：委派驗證以事件時間排序而非計劃列的更新時間"
```

---

### Task 4: Pause and resume during integration keep the plan `integrating`

`POST /v1/tasks/:id/control` calls `AgentCoordinator.propagateControl` after pausing or resuming a task (`src/http/server.ts`, the `/control` route). `propagateControl` rewrites every unfinished plan of that parent to `paused` or `waiting`, whatever the phase. A parent that is paused and resumed while it is integrating therefore ends up with a plan in state `waiting`, and `verifyIntegration` refuses it with `integration_incomplete`: before this plan that exception escaped from the reconciler on every tick; after Task 6 it would fail the task. The plan state must stay `integrating` while the parent is in its integration phase.

**Files:**
- Modify: `src/agents/coordinator.ts` (`propagateControl`, lines 529-564; the change is at lines 535-537 and 558-561)
- Test: `test/delegation-verification.test.ts`

**Interfaces:**
- Consumes (existing): `TaskService.control(ownerId, id, action)` — resuming a parent whose `orchestration.phase` is `'integration'` puts it back to `queued`; `AgentCoordinator.queueIntegration(ownerId, planId)` — sets the plan `integrating` and the parent's phase to `'integration'`; `changePlan` writes nothing when the callback returns the object it was given. (Tasks 1-2): test helpers `harness`, `wrote`, `read`, `isChild`, `principal`.
- Produces: `AgentCoordinator.propagateControl(ownerId: string, parentTaskId: string, action: 'pause' | 'resume' | 'cancel', actor?: Principal): Promise<void>` — signature unchanged. For `pause` and `resume`, a plan whose parent task has `orchestration.planId === plan.id` and `orchestration.phase === 'integration'` is set to (or left at) `integrating`; every other case is as before (`paused` on pause, `waiting` on resume, `cancelled` on cancel). No write happens when the plan already has the target state. Task 7 relies on `propagateControl(ownerId, parentId, 'cancel')` setting an `integrating` plan to `cancelled`.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/delegation-verification.test.ts`:

```ts

test('pausing and resuming a parent during integration keeps its plan integrating and the parent completes', async () => {
  const h = harness((task) => isChild(task) ? [wrote('result.txt')] : [read('result.txt')]);
  try {
    const { parentId, planId } = await h.start();
    await h.service.drain();
    await h.coordinator.queueIntegration(principal.id, planId);
    const queued = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(queued.data.state, 'integrating');

    await h.service.control(principal.id, parentId, 'pause');
    await h.coordinator.propagateControl(principal.id, parentId, 'pause');
    const paused = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(paused.data.state, 'integrating');
    assert.equal(paused.revision, queued.revision);

    await h.service.control(principal.id, parentId, 'resume');
    await h.coordinator.propagateControl(principal.id, parentId, 'resume');
    const resumed = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(resumed.data.state, 'integrating');
    assert.equal(resumed.revision, queued.revision);

    await h.service.drain();
    const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'completed', parent.data.error);
    assert.equal(parent.data.orchestration?.verification, 'passed');
  } finally {
    await h.close();
  }
});

test('resuming repairs a plan that an earlier version left paused or waiting during integration', async () => {
  for (const stored of ['paused', 'waiting'] as const) {
    const h = harness((task) => isChild(task) ? [wrote('result.txt')] : [read('result.txt')]);
    try {
      const { parentId, planId } = await h.start();
      await h.service.drain();
      await h.coordinator.queueIntegration(principal.id, planId);
      await h.service.control(principal.id, parentId, 'pause');
      const plan = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
      await h.store.put('agent_plan', planId, principal.id, { ...plan.data, state: stored }, plan.revision);

      await h.service.control(principal.id, parentId, 'resume');
      await h.coordinator.propagateControl(principal.id, parentId, 'resume');

      assert.equal((await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'integrating', stored);
      await h.service.drain();
      assert.equal((await h.store.get<Task>('task', parentId, principal.id))?.data.state, 'completed', stored);
    } finally {
      await h.close();
    }
  }
});

test('pause, resume and cancel outside integration behave as before', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'unused' }));
  const coordinator = new AgentCoordinator(store, (ownerId, taskId, action) => service.control(ownerId, taskId, action));
  const planState = async (planId: string) => (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state;
  const taskState = async (taskId: string) => (await store.get<Task>('task', taskId, principal.id))?.data.state;
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Control', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const parent = await service.enqueue(principal, conversation.id, 'Coordinate');
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'control', children: [{ key: 'worker', prompt: 'Wait' }], budget: { maxCalls: 2, maxTokens: 100 },
    });
    const childId = plan.data.childIds[0]!;

    await service.control(principal.id, parent.id, 'pause');
    await coordinator.propagateControl(principal.id, parent.id, 'pause');
    assert.deepEqual([await planState(plan.id), await taskState(childId)], ['paused', 'paused']);

    await service.control(principal.id, parent.id, 'resume');
    await coordinator.propagateControl(principal.id, parent.id, 'resume');
    assert.deepEqual([await planState(plan.id), await taskState(childId), await taskState(parent.id)],
      ['waiting', 'queued', 'waiting_for_children']);

    await service.control(principal.id, parent.id, 'cancel');
    await coordinator.propagateControl(principal.id, parent.id, 'cancel');
    assert.deepEqual([await planState(plan.id), await taskState(childId)], ['cancelled', 'cancelled']);

    await coordinator.propagateControl(principal.id, 'no-such-task', 'pause');
  } finally {
    await service.close();
    await store.close();
  }
});

test('cancelling a parent during integration cancels its plan', async () => {
  const h = harness((task) => isChild(task) ? [wrote('result.txt')] : [read('result.txt')]);
  try {
    const { parentId, planId } = await h.start();
    await h.service.drain();
    await h.coordinator.queueIntegration(principal.id, planId);
    await h.service.control(principal.id, parentId, 'cancel');
    await h.coordinator.propagateControl(principal.id, parentId, 'cancel');
    assert.equal((await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'cancelled');
    assert.equal((await h.store.get<Task>('task', parentId, principal.id))?.data.state, 'cancelled');
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/delegation-verification.test.ts`

Expected: the first two new tests fail; the last two pass already and guard the behaviour that must not change:

```
ℹ tests 17
ℹ pass 15
ℹ fail 2

✖ pausing and resuming a parent during integration keeps its plan integrating and the parent completes
  + 'paused'
  - 'integrating'
✖ resuming repairs a plan that an earlier version left paused or waiting during integration
  AssertionError [ERR_ASSERTION]: paused
  + 'waiting'
  - 'integrating'
```

- [ ] **Step 3: Write minimal implementation**

`src/agents/coordinator.ts`, edit 1 of 2 — inside `propagateControl` (lines 536-537): read the parent once before the loop. Replace:

```ts
      .filter((plan) => plan.data.parentTaskId === parentTaskId && !['completed', 'cancelled'].includes(plan.data.state));
    for (const plan of plans) {
```

with:

```ts
      .filter((plan) => plan.data.parentTaskId === parentTaskId && !['completed', 'cancelled'].includes(plan.data.state));
    const parent = plans.length ? await this.store.get<Task>('task', parentTaskId, ownerId) : undefined;
    for (const plan of plans) {
```

`src/agents/coordinator.ts`, edit 2 of 2 — inside `propagateControl` (lines 558-561): a plan whose parent is integrating stays `integrating` for pause and resume. Replace:

```ts
      await this.changePlan(ownerId, plan.id, (current) => ({
        ...current,
        state: action === 'cancel' ? 'cancelled' : action === 'resume' ? 'waiting' : 'paused',
      }));
```

with:

```ts
      const integrating = parent?.data.orchestration?.planId === plan.id
        && parent.data.orchestration.phase === 'integration';
      const state = action === 'cancel'
        ? 'cancelled'
        : integrating ? 'integrating' : action === 'resume' ? 'waiting' : 'paused';
      await this.changePlan(ownerId, plan.id, (current) => current.state === state ? current : { ...current, state });
```

The parent is read with `store.get`, not `requireTask`, so a task id that does not exist stays a silent no-op as it is today.

Known limit, accepted: the repair happens on the next resume. A parent that an earlier version already resumed during integration (plan stored as `waiting`, parent `queued` or `running`) and that is still in that run when the new version starts is not resumed again; from Task 6 on it ends `failed` with `integration_incomplete` instead of a verification message. The window is one integration run at deployment time, and on the earlier version the same task stalled every tick once it completed. Do not widen the precondition of `verifyIntegration` to cover it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/delegation-verification.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts`

Expected: no type errors; every test passes (33 as of commit `17d571f`: 16 existing plus 17 in the new file):

```
ℹ tests 33
ℹ pass 33
ℹ fail 0
```

- [ ] **Step 5: Commit**

```bash
git add src/agents/coordinator.ts test/delegation-verification.test.ts
git commit -m "修復：整合階段暫停或恢復時計劃維持整合中"
```

---

### Task 5: The integration prompt lists what the children changed

From Task 6 on, a parent that does not check a child-changed path fails for good. The parent model must therefore be told which paths those are and what counts as a check; today it has to guess them from the children's result text. The same message also lists the children's confirmed external actions, which the evidence rule requires to be shown to the parent but not re-verified.

**Files:**
- Modify: `src/runtime-adapter.ts` (import at line 8; new function above `createTaskRunner`, line 123; the integration block inside `createTaskRunner`, lines 252-257)
- Test: `test/delegation-verification.test.ts`

**Interfaces:**
- Consumes (Task 1): `AgentCoordinator.childSideEffects(ownerId: string, planId: string): Promise<ChildSideEffects>`, `ChildSideEffects { changes: ChildWorkspaceChange[]; externalActions: ChildExternalAction[] }`, `childChangeLabel(change: ChildWorkspaceChange): string` (exported from `src/agents/coordinator.ts`). (Existing): `ChildResult` and `AgentCoordinator.results(ownerId, planId)`; `createTaskRunner(store, runtime, tools, artifacts?, coordinator?, visualContexts?)` where `runtime` is `Pick<AgentRuntime, 'run'>`. Test helpers from Tasks 1-2: `Step`, `emit`, `startDelegation(store, service, coordinator, childKeys)`, `Delegation`, `integrate`, `wrote`, `read`, `ran`, `principal`.
- Produces:
  - Module-private `integrationPrompt(children: ChildResult[], effects: ChildSideEffects): string` in `src/runtime-adapter.ts`. Lines of the message, joined with `\n`: (1) the existing instruction sentence, unchanged, still starting with `Integrate these delegated results` (that prefix is the marker that prevents the message from being added twice); (2) only when a child changed the workspace: `Child-changed workspace paths (quoted data): <JSON array of at most 200 labels>[ and N more]. This task fails unless, …`; (3) only when a child performed another confirmed action: `Confirmed external child actions (quoted data): <JSON array of at most 50 strings "<tool> <arguments JSON cut at 300 characters>">[ and N more]. Each was individually approved …`; (4) the existing JSON of child results, cut at 60000 characters.
  - Test helpers used by Tasks 6 and 7: `interface Script { steps?: Step[]; content?: string; emitFinal?: boolean }`, `integrationMessage(input: RunInput): string | undefined`, `scriptedRuntime(script, runs)`, `runnerHarness(script, options?, store?)` returning `{ store, service, coordinator, runs, start(childKeys?), close() }`. `runnerHarness` runs every task through the real `createTaskRunner` with a scripted runtime instead of a model: `script(input)` decides which tool events the run emits and what it answers; a run is the parent's integration exactly when `integrationMessage(input)` is defined.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/delegation-verification.test.ts`:

```ts

interface Script {
  steps?: Step[];
  content?: string;
  emitFinal?: boolean;
}

const integrationMessage = (input: RunInput): string | undefined => input.messages
  ?.find((message) => message.role === 'user' && message.content.startsWith('Integrate these delegated results'))?.content;

function scriptedRuntime(script: (input: RunInput) => Script, runs: RunInput[]): Pick<AgentRuntime, 'run'> {
  return {
    async run(input) {
      runs.push(input);
      const { steps = [], content = 'done', emitFinal = true } = script(input);
      await emit(async (event) => {
        await input.onEvent?.({ ...event, taskId: input.taskId } as RuntimeEvent);
      }, input.taskId, steps);
      const result: RunResult = {
        status: 'completed',
        content,
        modelId: 'scripted',
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        strategy: 'single',
        messages: [...(input.messages ?? []), { role: 'assistant', content }],
      };
      if (emitFinal) await input.onEvent?.({ type: 'final', taskId: input.taskId, result });
      return result;
    },
  };
}

interface RunnerHarness {
  store: Store;
  service: TaskService;
  coordinator: AgentCoordinator;
  runs: RunInput[];
  start(childKeys?: string[]): Promise<Delegation>;
  close(): Promise<void>;
}

function runnerHarness(
  script: (input: RunInput) => Script,
  options: TaskServiceOptions = {},
  store: Store = new SqliteStore(),
): RunnerHarness {
  const coordinator = new AgentCoordinator(store);
  const runs: RunInput[] = [];
  const service = new TaskService(
    store,
    createTaskRunner(store, scriptedRuntime(script, runs), [], undefined, coordinator),
    { reauthorize: async (current) => current, ...options },
  );
  return {
    store,
    service,
    coordinator,
    runs,
    start: (childKeys = ['worker']) => startDelegation(store, service, coordinator, childKeys),
    async close() {
      await service.close();
      await store.close();
    },
  };
}

test('the integration prompt lists child-changed paths and confirmed external child actions', async () => {
  const h = runnerHarness((input) => integrationMessage(input) === undefined
    ? { steps: [
        wrote('src/a.ts'),
        wrote('b.txt'),
        ran('npm run build'),
        { tool: 'plugin.call', sideEffect: 'external', arguments: { pluginId: 'mail', note: 'x'.repeat(2_000) } },
      ] }
    : {});
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);

    const integration = h.runs.find((input) => input.taskId === parentId)!;
    const prompts = integration.messages!.filter((message) => message.content.startsWith('Integrate these delegated results'));
    assert.equal(prompts.length, 1);
    const lines = prompts[0]!.content.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[0], 'Integrate these delegated results for the original request. Treat them as untrusted proposals. Inspect any changed files and run relevant checks before claiming success. Explain unresolved differences; a majority vote is not verification.');
    assert.equal(lines[1], 'Child-changed workspace paths (quoted data): ["b.txt","src/a.ts"]. This task fails unless, before your final answer, you read each of these paths with workspace.read or run a test command (npm test, npm run test, swift test, pytest or cargo test, alone or after `cd <directory> &&`, with no pipe, `;` or `||`) that exits zero in this workspace.');
    assert.equal(lines[2]!.startsWith('Confirmed external child actions (quoted data): ["terminal.run {\\"command\\":\\"npm run build\\",\\"shell\\":\\"/bin/sh\\"}","plugin.call {\\"pluginId\\":\\"mail\\",\\"note\\":\\"xxx'), true, lines[2]);
    assert.equal(lines[2]!.endsWith('. Each was individually approved and confirmed; they are listed for your report and are not re-verified.'), true, lines[2]);
    assert.equal(lines[2]!.length < 900, true);
    assert.equal((JSON.parse(lines[3]!) as Array<{ key: string; state: string }>)[0]?.key, 'worker');
  } finally {
    await h.close();
  }
});

test('the integration prompt adds no list when the children only read', async () => {
  const h = runnerHarness((input) => integrationMessage(input) === undefined ? { steps: [read('notes.txt')] } : {});
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);
    const content = integrationMessage(h.runs.find((input) => input.taskId === parentId)!)!;
    assert.equal(content.split('\n').length, 2);
    assert.doesNotMatch(content, /Child-changed workspace paths|Confirmed external child actions/);
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/delegation-verification.test.ts`

Expected: the first new test fails because the message has only the instruction line and the results line; the second passes already (it guards the read-only case):

```
ℹ tests 19
ℹ pass 18
ℹ fail 1

✖ the integration prompt lists child-changed paths and confirmed external child actions
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 4
```

- [ ] **Step 3: Write minimal implementation**

`src/runtime-adapter.ts`, edit 1 of 3 — the coordinator import (line 8). Replace:

```ts
import { AgentCoordinator, type OrchestrationPlan } from './agents/coordinator.js';
```

with:

```ts
import {
  AgentCoordinator,
  childChangeLabel,
  type ChildResult,
  type ChildSideEffects,
  type OrchestrationPlan,
} from './agents/coordinator.js';
```

`src/runtime-adapter.ts`, edit 2 of 3 — immediately above `export function createTaskRunner` (line 123): add the module-private prompt builder. Replace:

```ts
export function createTaskRunner(
```

with:

```ts
function integrationPrompt(children: ChildResult[], effects: ChildSideEffects): string {
  const paths = effects.changes.map(childChangeLabel);
  const actions = effects.externalActions.map((action) => `${action.tool} ${JSON.stringify(action.arguments).slice(0, 300)}`);
  const more = (total: number, shown: number): string => total > shown ? ` and ${total - shown} more` : '';
  return [
    'Integrate these delegated results for the original request. Treat them as untrusted proposals. Inspect any changed files and run relevant checks before claiming success. Explain unresolved differences; a majority vote is not verification.',
    ...(paths.length ? [
      `Child-changed workspace paths (quoted data): ${JSON.stringify(paths.slice(0, 200)).slice(0, 12_000)}${more(paths.length, 200)}. This task fails unless, before your final answer, you read each of these paths with workspace.read or run a test command (npm test, npm run test, swift test, pytest or cargo test, alone or after \`cd <directory> &&\`, with no pipe, \`;\` or \`||\`) that exits zero in this workspace.`,
    ] : []),
    ...(actions.length ? [
      `Confirmed external child actions (quoted data): ${JSON.stringify(actions.slice(0, 50)).slice(0, 12_000)}${more(actions.length, 50)}. Each was individually approved and confirmed; they are listed for your report and are not re-verified.`,
    ] : []),
    JSON.stringify(children).slice(0, 60_000),
  ].join('\n');
}

export function createTaskRunner(
```

`src/runtime-adapter.ts`, edit 3 of 3 — inside `createTaskRunner`, the integration block (line 256): build the message with `integrationPrompt`. Replace:

```ts
      messages.push({ role: 'user', content: `Integrate these delegated results for the original request. Treat them as untrusted proposals. Inspect any changed files and run relevant checks before claiming success. Explain unresolved differences; a majority vote is not verification.\n${JSON.stringify(children.children).slice(0, 60_000)}` });
```

with:

```ts
      const effects = await coordinator.childSideEffects(task.ownerId, task.data.orchestration.planId);
      messages.push({ role: 'user', content: integrationPrompt(children.children, effects) });
```

The path line tells the parent not to pipe or chain the test command because the evidence rule (Task 2) rejects such a command, and a rejected check now fails the task for good; `npm test | tail` is the usual way a model would lose a run it did verify. The test above cuts a 2000-character argument to 300, which is what keeps the line under 900 characters.

Do not export `integrationPrompt`: `src/index.ts` re-exports everything from `src/runtime-adapter.ts`, and this function is not part of the package interface. Building the message costs one scan of the owner's events per integration start; once the integration run has checkpointed a tool result, the message is part of the task's stored messages and is not rebuilt on resume.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/delegation-verification.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts`

Expected: no type errors; every test passes (35 as of commit `17d571f`: 16 existing plus 19 in the new file). The existing MoA test, which matches on `startsWith('Integrate')`, is among them:

```
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime-adapter.ts test/delegation-verification.test.ts
git commit -m "實現：整合提示列出子任務變更的路徑與已確認的外部動作"
```

---

### Task 6: Verify inside the integration run, before the final answer is accepted

This is D1 and D2. Today `TaskService` stores the parent as `completed`, writes the assistant message and publishes `task_completed` as soon as the integration run returns; verification is attempted by a later reconciler tick and, when it cannot pass, is retried on every tick forever while the parent stays `completed` with verification `pending`. The gate moves into `createTaskRunner`: when the integration run produces its final answer, `verifyIntegration` runs before the `final` event is forwarded. A pass has already stored `verification: 'passed'` on the still-running parent, so the `completed` row that `TaskService` writes next carries it. A failure is thrown out of the runner, and the existing failure path of `TaskService` ends the task `failed` with the message (or `unknown` if a dispatch is unconfirmed, or `queued` if the run was aborted). `src/tasks.ts` is not changed.

**Files:**
- Modify: `src/runtime-adapter.ts` (`createTaskRunner`: above the `runtime.run` call at line 268, the `final` branch at line 297, the `return` at line 301)
- Test: `test/delegation-verification.test.ts`

**Interfaces:**
- Consumes (Task 2): `AgentCoordinator.verifyIntegration(ownerId: string, planId: string): Promise<Entity<OrchestrationPlan>>` — accepts a `running` parent, throws `DomainError('verification_failed', message, 409)` and marks the parent `'failed'`. (Task 4): the plan is still `integrating` after pause and resume. (Task 5): `runnerHarness(script, options?, store?)`, `integrationMessage(input)`, `Script`. (Tasks 1-2): `Step` with `unconfirmed`, `wrote`, `read`, `ran`, `integrate`, `principal`. (Existing): `TaskService` maps a runner error to `failed` + `task_failed`, to `unknown` + `task_unknown` when a `write`/`external` dispatch has no result, and to `queued` when the run was aborted; `NotificationService.reconcile()` publishes by task state on every tick; every non-token runtime event is persisted before `onEvent` resolves.
- Produces:
  - `createTaskRunner(store, runtime, tools, artifacts?, coordinator?, visualContexts?)` — signature unchanged. For a task whose `orchestration.phase` is `'integration'` and when `coordinator` is given: `verifyIntegration` is awaited once per run, on the `final` event before it is forwarded, or after `runtime.run` returns `status: 'completed'` if no `final` event was seen. It is not called for `waiting_for_approval` or `waiting_for_children` results, for children in phase `'children'`, or for tasks without orchestration. Any error propagates unchanged.
  - Invariant for readers of stored tasks: a parent written with state `completed` by a `TaskService` that uses `createTaskRunner` has `orchestration.verification === 'passed'`.
  - Test helpers used by Task 7: `class RecordingStore implements Store` (records `puts` and `reads`, delegates everything to a `SqliteStore`), `notificationTypes(store, taskId)`.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/delegation-verification.test.ts`:

```ts

class RecordingStore implements Store {
  public readonly puts: Array<{ kind: string; id: string; data: unknown }> = [];
  public readonly reads: Array<{ kind: string; id?: string }> = [];

  public constructor(private readonly delegate: Store = new SqliteStore()) {}

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.delegate.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    this.reads.push({ kind, id });
    return this.delegate.get(kind, id, ownerId);
  }

  public scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    this.reads.push({ kind });
    return this.delegate.scan(kind, ownerId);
  }

  public put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> {
    this.puts.push({ kind, id, data });
    return this.delegate.put(kind, id, ownerId, data, revision);
  }

  public remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> {
    return this.delegate.remove(kind, id, ownerId, revision);
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

const notificationTypes = async (store: Store, taskId: string): Promise<string[]> => (
  await store.scan<Notification>('notification', principal.id)
).filter((row) => row.data.taskId === taskId).map((row) => row.data.type).sort();

test('a delegated parent is never stored as completed before its verification has passed', async () => {
  const store = new RecordingStore();
  const h = runnerHarness((input) => integrationMessage(input) === undefined
    ? { steps: [wrote('result.txt'), ran('npm run build')], content: 'Child wrote result.txt.' }
    : { steps: [read('result.txt')], content: 'Integrated result.txt.' },
  { notifications: new NotificationService(store) }, store);
  try {
    const { parentId, planId, childIds } = await h.start();
    await integrate(h, planId);

    const parent = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'completed', parent.data.error);
    assert.equal(parent.data.result, 'Integrated result.txt.');
    assert.equal(parent.data.orchestration?.verification, 'passed');
    const completedWrites = store.puts.filter((put) => put.kind === 'task' && put.id === parentId
      && (put.data as Task).state === 'completed');
    assert.equal(completedWrites.length > 0, true);
    assert.deepEqual(completedWrites.map((put) => (put.data as Task).orchestration?.verification), completedWrites.map(() => 'passed'));
    const plan = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(plan.data.state, 'completed');
    assert.equal(plan.data.verification?.evidence,
      `Parent verified child resources: result.txt (${childIds[0]}:0:workspace.write). `
        + `Confirmed external child actions, individually approved and not re-verified: terminal.run (${childIds[0]}:1:terminal.run)`);
    assert.equal((await store.get<Message>('message', `${parentId}:assistant`, principal.id))?.data.content, 'Integrated result.txt.');
    assert.deepEqual(await notificationTypes(store, parentId), ['task_completed']);
    const child = (await store.get<Task>('task', childIds[0]!, principal.id))!;
    assert.deepEqual([child.data.state, child.data.orchestration?.verification], ['completed', 'pending']);
  } finally {
    await h.close();
  }
});

test('a parent that answers without checking a child change fails and nothing reports completion', async () => {
  for (const emitFinal of [true, false]) {
    const store = new SqliteStore();
    const h = runnerHarness((input) => integrationMessage(input) === undefined
      ? { steps: [wrote('result.txt')] }
      : { content: 'Everything is done.', emitFinal },
    { notifications: new NotificationService(store) }, store);
    try {
      const { parentId, planId } = await h.start();
      await integrate(h, planId);
      await h.service.drain();
      await h.service.drain();

      const parent = (await store.get<Task>('task', parentId, principal.id))!;
      assert.equal(parent.data.state, 'failed', `emitFinal=${emitFinal}`);
      assert.match(parent.data.error!, /^Delegated work is unverified\. .* Not verified: result\.txt$/);
      assert.equal(parent.data.orchestration?.verification, 'failed');
      assert.equal(parent.data.result, undefined);
      assert.equal(await store.get('message', `${parentId}:assistant`, principal.id), undefined);
      const eventTypes = (await h.service.events(principal.id, parentId)).map((event) => event.data.type);
      assert.equal(eventTypes.includes('completed'), false);
      assert.equal(eventTypes.includes('final'), false, `emitFinal=${emitFinal}`);
      assert.deepEqual(await notificationTypes(store, parentId), ['task_failed']);
      assert.notEqual((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'completed');
      assert.equal(h.runs.filter((input) => input.taskId === parentId).length, 1);
    } finally {
      await h.close();
    }
  }
});

test('an unconfirmed parent dispatch still ends unknown when verification also fails', async () => {
  const store = new SqliteStore();
  const h = runnerHarness((input) => integrationMessage(input) === undefined
    ? { steps: [wrote('result.txt')] }
    : { steps: [{ tool: 'plugin.call', sideEffect: 'external', arguments: { to: 'list' }, unconfirmed: true }] },
  { notifications: new NotificationService(store) }, store);
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);
    const parent = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'unknown');
    assert.deepEqual(await notificationTypes(store, parentId), ['task_unknown']);
  } finally {
    await h.close();
  }
});

test('a parent whose plan was already verified before an interruption completes on its next run', async () => {
  const h = runnerHarness((input) => integrationMessage(input) === undefined ? { steps: [wrote('result.txt')] } : {});
  try {
    const { parentId, planId } = await h.start();
    await h.service.drain();
    await h.coordinator.queueIntegration(principal.id, planId);
    const plan = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    const verified = await h.store.put<OrchestrationPlan>('agent_plan', planId, principal.id, {
      ...plan.data,
      state: 'completed',
      verification: { at: new Date().toISOString(), evidence: 'Verified before interruption.' },
    }, plan.revision);

    await h.service.drain();

    const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'completed', parent.data.error);
    assert.equal(parent.data.orchestration?.verification, 'passed');
    const after = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(after.revision, verified.revision);
    assert.equal(after.data.verification?.evidence, 'Verified before interruption.');
  } finally {
    await h.close();
  }
});

test('a task that never delegated completes without verification', async () => {
  const h = runnerHarness(() => ({ content: 'Plain answer.' }));
  try {
    const conversation = await h.store.create<Conversation>('conversation', principal.id, {
      title: 'Plain', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
    });
    const task = await h.service.enqueue(principal, conversation.id, 'Answer directly');
    await h.service.drain();
    const done = (await h.store.get<Task>('task', task.id, principal.id))!;
    assert.equal(done.data.state, 'completed', done.data.error);
    assert.equal(done.data.orchestration, undefined);
    assert.deepEqual(await h.store.scan('agent_plan', principal.id), []);
  } finally {
    await h.close();
  }
});

test('end to end: an approved child write, a parent read and an approved parent write complete with verification passed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-verify-workspace-'));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-verify-checkpoints-'));
  const store = new SqliteStore();
  const tools = await createWorkspaceTools({ checkpointDirectory: checkpoints });
  let parentId = '';
  let integrationPrompt = '';
  const usage = { inputTokens: 1, outputTokens: 1 };
  const call = (id: string, name: string, input: Record<string, unknown>) => ({
    message: { role: 'assistant' as const, content: '', toolCalls: [{ id, name, arguments: input }] },
    usage,
  });
  const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat(request) {
    const toolResults = request.messages.filter((message) => message.role === 'tool' && message.name !== 'agent.delegate');
    if (request.context!.taskId !== parentId) {
      return toolResults.length === 0
        ? call('write-child', 'workspace.write', { path: 'child.txt', content: 'child output\n' })
        : { message: { role: 'assistant', content: 'Wrote child.txt.' }, usage };
    }
    const prompt = request.messages.find((message) => message.role === 'user'
      && message.content.startsWith('Integrate these delegated results'));
    if (!prompt) return call('delegate', 'agent.delegate', { prompt: 'Write child.txt', childKey: 'writer' });
    integrationPrompt = prompt.content;
    if (toolResults.length === 0) return call('read-child', 'workspace.read', { path: 'child.txt' });
    if (toolResults.length === 1) return call('write-summary', 'workspace.write', { path: 'summary.txt', content: 'summary\n' });
    return { message: { role: 'assistant', content: 'Integrated child.txt into summary.txt.' }, usage };
  } };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming', 'tools'] }],
    tools,
  });
  const coordinator = new AgentCoordinator(store);
  const service = new TaskService(store, createTaskRunner(store, runtime, tools, undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  const approve = async (taskId: string): Promise<void> => {
    const waiting = (await store.get<Task>('task', taskId, principal.id))!;
    assert.equal(waiting.data.state, 'waiting_for_approval', waiting.data.error);
    await service.control(principal.id, taskId, 'resume', waiting.data.pendingActions.map((action) => action.hash), principal);
    await service.drain();
  };
  try {
    const workspace = await store.create('workspace', principal.id, {
      name: 'Shared', root, deviceId: 'server', capabilities: ['workspace:read', 'workspace:write'], allowCloud: true,
    });
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'End to end', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', workspaceId: workspace.id, archived: false,
    });
    const parent = await service.enqueue(principal, conversation.id, 'Delegate the file and integrate it');
    parentId = parent.id;
    await service.drain();
    const plan = (await store.scan<OrchestrationPlan>('agent_plan', principal.id))[0]!;
    await approve(plan.data.childIds[0]!);
    assert.equal(await readFile(path.join(root, 'child.txt'), 'utf8'), 'child output\n');

    await reconcileAgentTasks(store, coordinator);
    await service.drain();
    assert.match(integrationPrompt, /Child-changed workspace paths \(quoted data\): \["child\.txt"\]/);
    await approve(parent.id);

    const done = (await store.get<Task>('task', parent.id, principal.id))!;
    assert.equal(done.data.state, 'completed', done.data.error);
    assert.equal(done.data.result, 'Integrated child.txt into summary.txt.');
    assert.equal(done.data.orchestration?.verification, 'passed');
    assert.match((await store.get<OrchestrationPlan>('agent_plan', plan.id, principal.id))!.data.verification!.evidence,
      /^Parent verified child resources: child\.txt \([a-f0-9]{64}\)$/);
    assert.equal(await readFile(path.join(root, 'summary.txt'), 'utf8'), 'summary\n');
  } finally {
    await service.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/delegation-verification.test.ts`

Expected: five of the six new tests fail; `a task that never delegated completes without verification` passes already:

```
ℹ tests 25
ℹ pass 20
ℹ fail 5

✖ a delegated parent is never stored as completed before its verification has passed
  + 'pending'
  - 'passed'
✖ a parent that answers without checking a child change fails and nothing reports completion
  AssertionError [ERR_ASSERTION]: emitFinal=true
  + 'completed'
  - 'failed'
✖ an unconfirmed parent dispatch still ends unknown when verification also fails
  + 'completed'
  - 'unknown'
✖ a parent whose plan was already verified before an interruption completes on its next run
  + 'pending'
  - 'passed'
✖ end to end: an approved child write, a parent read and an approved parent write complete with verification passed
  + 'pending'
  - 'passed'
```

- [ ] **Step 3: Write minimal implementation**

`src/runtime-adapter.ts`, edit 1 of 3 — inside `createTaskRunner`, immediately above `const result = await runtime.run({` (line 268): add the gate. Replace:

```ts
    const result = await runtime.run({
```

with:

```ts
    const integrationPlanId = coordinator && task.data.orchestration?.phase === 'integration'
      ? task.data.orchestration.planId
      : undefined;
    let integrationVerified = false;
    const verifyIntegration = async (): Promise<void> => {
      if (!coordinator || !integrationPlanId || integrationVerified) return;
      await coordinator.verifyIntegration(task.ownerId, integrationPlanId);
      integrationVerified = true;
    };
    const result = await runtime.run({
```

`src/runtime-adapter.ts`, edit 2 of 3 — inside the `onEvent` callback passed to `runtime.run` (line 297): verify before the `final` event is forwarded. Replace:

```ts
        if (event.type === 'final') return onEvent({ ...event, result: { ...event.result, messages: withoutImageData(event.result.messages) } });
```

with:

```ts
        if (event.type === 'final') {
          await verifyIntegration();
          return onEvent({ ...event, result: { ...event.result, messages: withoutImageData(event.result.messages) } });
        }
```

`src/runtime-adapter.ts`, edit 3 of 3 — the `return` that follows the `runtime.run` call (line 301): verify a completed run that emitted no `final` event. Replace:

```ts
    return { text: result.content, status: result.status, messages: withoutImageData(result.messages), usage: result.usage,
```

with:

```ts
    if (result.status === 'completed') await verifyIntegration();
    return { text: result.content, status: result.status, messages: withoutImageData(result.messages), usage: result.usage,
```

Why both call sites: the real `AgentRuntime` always emits `final` for a completed single-strategy run, and verifying there keeps a `final` event (which clients stream) from ever being recorded for an answer that is then rejected. The call after `runtime.run` covers a runtime that returns `completed` without emitting `final`; `integrationVerified` makes it a no-op otherwise.

Do not catch the error, and do not add a parameter: plan E appends a seventh parameter to this function.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/delegation-verification.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts`

Expected: no type errors; every test passes (41 as of commit `17d571f`: 16 existing plus 25 in the new file):

```
ℹ tests 41
ℹ pass 41
ℹ fail 0
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime-adapter.ts test/delegation-verification.test.ts
git commit -m "修復：父任務在整合驗證通過後才算完成"
```

---

### Task 7: The reconciler stops verifying and does bounded work per tick

This is D3. `reconcileAgentTasks` runs on every tick (once a second) for every owner. Today it calls `verifyIntegration` for every completed parent whose verification has not passed, which scans all of that owner's events each time and can never succeed for the rows it keeps retrying; it also reads the parent of every completed plan forever, and it lets `integration_incomplete` escape, which aborts the whole tick before any task is claimed. After Task 6 nothing needs to be verified outside the integration run, so the reconciler only moves waiting parents forward. It additionally closes the plan of a parent that ended `failed` or `cancelled` while integrating, so that plan is not looked at again. A parent that is `unknown` keeps its plan: workstream B2 can reconcile and requeue it, and its next integration run needs the plan to be `integrating`.

Rows already stored as `completed` with verification `pending` are not touched: they are not `failed` or `cancelled`, and they are not `waiting_for_children`, so the loop skips them after one keyed read.

**Files:**
- Modify: `src/runtime-adapter.ts` (`reconcileAgentTasks`, lines 309-350)
- Modify: `test/agents-runtime.test.ts` (test at lines 238-327: title and last three lines; test at lines 329-371: deleted)
- Modify: `README.md` (Components list, line 60)
- Test: `test/delegation-verification.test.ts`

**Interfaces:**
- Consumes (Task 4): `AgentCoordinator.propagateControl(ownerId, parentTaskId, 'cancel')` sets an unfinished plan of that parent to `cancelled`; when every child is already terminal it changes no task. (Task 6): a parent stored `completed` through `createTaskRunner` already has verification `passed`. (Tasks 5-6): test helpers `runnerHarness`, `integrationMessage`, `RecordingStore` (`reads` holds `{ kind, id }` for every `get` and `{ kind }` for every `scan`), `integrate`, `wrote`, `read`, `principal`. (Existing): `TaskService.setReconciler(fn)` makes every tick call `fn` before claiming tasks; `TaskService.drain()` rejects when a tick throws.
- Produces: `reconcileAgentTasks(store: Store, coordinator: AgentCoordinator): Promise<void>` — signature unchanged. Per tick: one scan of `agent_plan`; for each plan in state `waiting` or `integrating` one keyed read of its parent; the existing children-ready handling only when the parent is `waiting_for_children`; one `propagateControl(…, 'cancel')` for an `integrating` plan whose parent is `failed` or `cancelled`. It never calls `verifyIntegration`, never scans events, and never visits a `completed`, `cancelled`, `paused` or `preparing` plan.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/delegation-verification.test.ts`:

```ts

const countEventScans = (reads: RecordingStore['reads']): number => reads.filter((entry) => entry.kind === 'event').length;

test('the reconciler closes the plan of a parent that failed verification and then leaves it alone', async () => {
  const store = new RecordingStore();
  const h = runnerHarness((input) => integrationMessage(input) === undefined ? { steps: [wrote('result.txt')] } : {}, {}, store);
  try {
    const { parentId, planId } = await h.start();
    await integrate(h, planId);
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'failed');
    assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'integrating');

    const first = store.reads.length;
    await reconcileAgentTasks(store, h.coordinator);
    const closed = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(closed.data.state, 'cancelled');

    const later = store.reads.length;
    await reconcileAgentTasks(store, h.coordinator);
    await reconcileAgentTasks(store, h.coordinator);
    assert.equal(countEventScans(store.reads.slice(first)), 0);
    assert.deepEqual(store.reads.slice(later), [{ kind: 'agent_plan' }, { kind: 'agent_plan' }]);
    assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.revision, closed.revision);
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.orchestration?.verification, 'failed');
  } finally {
    await h.close();
  }
});

test('a parent stored as completed with pending verification is left as stored and costs no event scan', async () => {
  const store = new RecordingStore();
  const h = runnerHarness((input) => integrationMessage(input) === undefined ? { steps: [wrote('result.txt')] } : {}, {
    notifications: new NotificationService(store),
  }, store);
  try {
    const { parentId, planId } = await h.start();
    await h.service.drain();
    await h.coordinator.queueIntegration(principal.id, planId);
    const queued = (await store.get<Task>('task', parentId, principal.id))!;
    const legacy = await store.put<Task>('task', parentId, principal.id, {
      ...queued.data, state: 'completed', result: 'Answer stored by an earlier version.',
    }, queued.revision);
    const plan = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;

    const before = store.reads.length;
    for (let tick = 0; tick < 3; tick += 1) await reconcileAgentTasks(store, h.coordinator);
    assert.equal(countEventScans(store.reads.slice(before)), 0);

    const after = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(after.revision, legacy.revision);
    assert.deepEqual([after.data.state, after.data.orchestration?.verification, after.data.error],
      ['completed', 'pending', undefined]);
    const samePlan = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.deepEqual([samePlan.data.state, samePlan.revision], ['integrating', plan.revision]);
  } finally {
    await h.close();
  }
});

test('a plan left waiting by an earlier pause and resume no longer stops the tick for other tasks', async () => {
  const h = runnerHarness((input) => integrationMessage(input) === undefined ? { steps: [read('notes.txt')] } : {});
  try {
    const { parentId, planId } = await h.start();
    await h.service.drain();
    await h.coordinator.queueIntegration(principal.id, planId);
    const plan = (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    await h.store.put('agent_plan', planId, principal.id, { ...plan.data, state: 'waiting' }, plan.revision);
    const parent = (await h.store.get<Task>('task', parentId, principal.id))!;
    await h.store.put('task', parentId, principal.id, { ...parent.data, state: 'completed' }, parent.revision);

    h.service.setReconciler(() => reconcileAgentTasks(h.store, h.coordinator));
    const conversation = await h.store.create<Conversation>('conversation', principal.id, {
      title: 'Unrelated', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
    });
    const other = await h.service.enqueue(principal, conversation.id, 'Unrelated work');
    await h.service.drain();

    assert.equal((await h.store.get<Task>('task', other.id, principal.id))?.data.state, 'completed');
    assert.equal((await h.store.get<Task>('task', parentId, principal.id))?.data.orchestration?.verification, 'pending');
  } finally {
    await h.close();
  }
});

test('an unknown parent keeps its integrating plan and a cancelled parent has it closed', async () => {
  const h = runnerHarness((input) => integrationMessage(input) === undefined ? { steps: [wrote('result.txt')] } : {});
  const planState = async (planId: string) => (await h.store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state;
  try {
    const { parentId, planId } = await h.start();
    await h.service.drain();
    await h.coordinator.queueIntegration(principal.id, planId);
    const queued = (await h.store.get<Task>('task', parentId, principal.id))!;
    const unknown = await h.store.put<Task>('task', parentId, principal.id, { ...queued.data, state: 'unknown' }, queued.revision);

    await reconcileAgentTasks(h.store, h.coordinator);
    assert.equal(await planState(planId), 'integrating');

    await h.store.put<Task>('task', parentId, principal.id, { ...unknown.data, state: 'cancelled' }, unknown.revision);
    await reconcileAgentTasks(h.store, h.coordinator);
    assert.equal(await planState(planId), 'cancelled');
  } finally {
    await h.close();
  }
});

test('with the reconciler wired into the tick a verified parent completes and its plan is not visited again', async () => {
  const store = new RecordingStore();
  const h = runnerHarness((input) => integrationMessage(input) === undefined
    ? { steps: [wrote('result.txt')] }
    : { steps: [read('result.txt')], content: 'Integrated.' }, {}, store);
  try {
    h.service.setReconciler(() => reconcileAgentTasks(store, h.coordinator));
    const { parentId, planId } = await h.start();
    await h.service.drain();

    const parent = (await store.get<Task>('task', parentId, principal.id))!;
    assert.deepEqual([parent.data.state, parent.data.orchestration?.verification], ['completed', 'passed']);
    assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'completed');
    assert.equal(h.runs.filter((input) => input.taskId === parentId).length, 1);

    const before = store.reads.length;
    await reconcileAgentTasks(store, h.coordinator);
    await reconcileAgentTasks(store, h.coordinator);
    assert.deepEqual(store.reads.slice(before), [{ kind: 'agent_plan' }, { kind: 'agent_plan' }]);
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/delegation-verification.test.ts`

Expected: all five new tests fail:

```
ℹ tests 30
ℹ pass 25
ℹ fail 5

✖ the reconciler closes the plan of a parent that failed verification and then leaves it alone
  + 'integrating'
  - 'cancelled'
✖ a parent stored as completed with pending verification is left as stored and costs no event scan
  3 !== 0
✖ a plan left waiting by an earlier pause and resume no longer stops the tick for other tasks
  Error [DomainError]: Parent integration must be running or complete before verification
    code: 'integration_incomplete',
✖ an unknown parent keeps its integrating plan and a cancelled parent has it closed
  + 'integrating'
  - 'cancelled'
✖ with the reconciler wired into the tick a verified parent completes and its plan is not visited again
  (the actual list also contains { kind: 'task', id: … } after each { kind: 'agent_plan' })
```

- [ ] **Step 3: Write minimal implementation**

`src/runtime-adapter.ts`, edit 1 of 2 — the head of the loop in `reconcileAgentTasks` (lines 311-320): visit only unfinished plans, drop the verification of completed plans, and close an `integrating` plan whose parent has ended `failed` or `cancelled`. Replace:

```ts
    if (!['waiting', 'integrating', 'completed'].includes(plan.data.state)) continue;
    const parent = await store.get<Task>('task', plan.data.parentTaskId, plan.ownerId);
    if (!parent) continue;
    if (plan.data.state === 'completed') {
      if (parent.data.state === 'completed' && parent.data.orchestration?.verification !== 'passed') {
        await coordinator.verifyIntegration(plan.ownerId, plan.id);
      }
      continue;
    }
    if (['failed', 'cancelled', 'unknown'].includes(parent.data.state)) continue;
```

with:

```ts
    if (!['waiting', 'integrating'].includes(plan.data.state)) continue;
    const parent = await store.get<Task>('task', plan.data.parentTaskId, plan.ownerId);
    if (!parent) continue;
    if (['failed', 'cancelled'].includes(parent.data.state)) {
      if (plan.data.state === 'integrating') await coordinator.propagateControl(plan.ownerId, parent.id, 'cancel');
      continue;
    }
```

`src/runtime-adapter.ts`, edit 2 of 2 — the tail of the loop in `reconcileAgentTasks` (lines 341-350, as edited by Task 2): remove the verification branch. Replace:

```ts
      }
    } else if (parent.data.state === 'completed' && parent.data.orchestration?.verification !== 'passed') {
      try {
        await coordinator.verifyIntegration(plan.ownerId, plan.id);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'verification_failed')) throw error;
      }
    }
  }
}
```

with:

```ts
      }
    }
  }
}
```

`test/agents-runtime.test.ts`, edit 1 of 3 — the title of the test at line 238: verification is no longer automatic for a runner that does not use `createTaskRunner`. Replace:

```ts
test('automatic integration verification requires a correlated inspection after child side effects', async () => {
```

with:

```ts
test('integration verification requires a correlated inspection after child side effects', async () => {
```

`test/agents-runtime.test.ts`, edit 2 of 3 — the end of that test (lines 323-325): the reconciler no longer verifies, so the test calls the coordinator itself. Replace:

```ts
    }, `${root.id}:inspection-result`);
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await coordinator.results(principal.id, plan.id)).plan.data.state, 'completed');
```

with:

```ts
    }, `${root.id}:inspection-result`);
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await coordinator.results(principal.id, plan.id)).plan.data.state, 'integrating');
    await coordinator.verifyIntegration(principal.id, plan.id);
    assert.equal((await coordinator.results(principal.id, plan.id)).plan.data.state, 'completed');
```

`test/agents-runtime.test.ts`, edit 3 of 3 — the last test of the file as of commit `17d571f` (lines 329-371, plus the blank line 328 before it): delete it. Its premise, that the reconciler repairs a completed parent, is what D3 removes; the interrupted-verification case is covered by `a parent whose plan was already verified before an interruption completes on its next run` (Task 6) and the stored-row case by `a parent stored as completed with pending verification is left as stored and costs no event scan` (this task). Delete exactly these lines, the leading blank line included, so that the test above it ends with `});` followed by a single newline and no blank line is left behind (if an earlier plan appended tests after this one, keep one blank line between the remaining tests):

```ts

test('reconciliation finishes a parent verification interrupted after the plan commit', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const tasks = new TaskService(store, async () => ({ text: 'done' }));
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Recover verification',
      scope: 'private',
      modelPolicy: 'cloud',
      strategy: 'single',
      mode: 'ask',
      archived: false,
    });
    const parent = await tasks.enqueue(principal, conversation.id, 'Coordinate');
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'recover-verification',
      budget: { maxCalls: 2, maxTokens: 100 },
      children: [{ key: 'worker', prompt: 'Inspect' }],
    });
    const currentPlan = (await store.get<typeof plan.data>('agent_plan', plan.id, principal.id))!;
    await store.put('agent_plan', plan.id, principal.id, {
      ...currentPlan.data,
      state: 'completed',
      verification: { at: new Date().toISOString(), evidence: 'Verified before interruption.' },
    }, currentPlan.revision);
    const currentParent = (await store.get<Task>('task', parent.id, principal.id))!;
    await store.put('task', parent.id, principal.id, {
      ...currentParent.data,
      state: 'completed',
      orchestration: { ...currentParent.data.orchestration!, phase: 'integration', verification: 'pending' },
    }, currentParent.revision);

    await reconcileAgentTasks(store, coordinator);

    assert.equal(
      (await store.get<Task>('task', parent.id, principal.id))?.data.orchestration?.verification,
      'passed',
    );
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

`README.md`, edit 1 of 1 — the "Expert and MoA tasks" bullet of the Components list (line 60). Replace:

```md
- Expert and MoA tasks create durable child tasks with a shared budget and a single parent integration. Child failure does not silently produce a successful parent task.
```

with:

```md
- Expert and MoA tasks create durable child tasks with a shared budget and a single parent integration. Child failure does not silently produce a successful parent task. A parent completes only after its integration run has read, or passed a test command over, every workspace path its children changed; otherwise it fails with `verification_failed` and names the unverified paths. Other child actions were each approved and confirmed; they are listed to the parent and recorded, not re-verified.
```

After these edits `reconcileAgentTasks` reads as follows; the block inside `if (parent.data.state === 'waiting_for_children')` is untouched (plan E edits one line inside it):

```ts
export async function reconcileAgentTasks(store: Store, coordinator: AgentCoordinator): Promise<void> {
  for (const plan of await store.scan<OrchestrationPlan>('agent_plan')) {
    if (!['waiting', 'integrating'].includes(plan.data.state)) continue;
    const parent = await store.get<Task>('task', plan.data.parentTaskId, plan.ownerId);
    if (!parent) continue;
    if (['failed', 'cancelled'].includes(parent.data.state)) {
      if (plan.data.state === 'integrating') await coordinator.propagateControl(plan.ownerId, parent.id, 'cancel');
      continue;
    }
    if (parent.data.state === 'waiting_for_children') {
      const result = await coordinator.results(plan.ownerId, plan.id);
      if (!result.ready) continue;
      if (result.successful) await coordinator.queueIntegration(plan.ownerId, plan.id);
      else {
        const error = result.children.filter((child) => child.state !== 'completed').map((child) => `${child.key}: ${child.state}`).join('; ');
        const state = result.children.some((child) => child.state === 'unknown')
          ? 'unknown'
          : result.children.some((child) => child.state === 'cancelled')
            ? 'cancelled'
            : 'failed';
        try {
          await store.put('task', parent.id, parent.ownerId, { ...parent.data, state, error: `Delegated work requires attention: ${error}`, workerId: undefined, leaseExpiresAt: undefined }, parent.revision);
          await store.create('notification', parent.ownerId, {
            type: state === 'unknown' ? 'task_unknown' : 'task_failed',
            taskId: parent.id,
            conversationId: parent.data.conversationId,
            read: false,
          }, `${parent.id}:children-${state}`);
        } catch (failure) { if (!(failure instanceof DomainError && failure.code === 'conflict')) throw failure; }
      }
    }
  }
}
```

Only an `integrating` plan is closed: its children are all terminal, so `propagateControl` changes nothing but the plan. A `waiting` plan can still have running children, and cancelling those would need the control adapter; that case is left exactly as it is today.

`test/standalone.acceptance.ts` needs no change: it waits for the delegated parent to be `completed` with verification `passed` and matches the evidence against `/delegated\.txt/`, and both still hold.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/delegation-verification.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts`

Expected: no type errors; every test passes (45 as of commit `17d571f`: 15 existing, one was deleted, plus 30 in the new file):

```
ℹ tests 45
ℹ pass 45
ℹ fail 0
```

Then run the delivery gate: `npm run check`

Expected: `tsc --noEmit` prints nothing; the test run ends with `ℹ fail 0` (the total depends on the earlier plans; PostgreSQL contract cases from plan G are reported as skipped unless `KIANCODE_TEST_DATABASE_URL` is set); `tsc -p tsconfig.build.json` prints nothing and the command exits 0.

Not validated locally: the complete `npm run check`. In the scratch copy `npx tsc --noEmit`, `npx tsc -p tsconfig.build.json --noEmit` and 41 of the 46 test files (240 tests, 0 failures) were run after this task; the five files that open loopback listeners or start a browser (`bootstrap-device-tools`, `bootstrap-task-runner-hook`, `device-artifact`, `device-websocket`, `plugins-browser`) and the emitting build were not. Those five files only run tasks that never delegate, which the gate skips (pinned by `a task that never delegated completes without verification` in Task 6). The acceptance script (`npm run acceptance`, plan G) was not run either: it needs PostgreSQL and a Bubblewrap workspace.

- [ ] **Step 5: Commit**

```bash
git add src/runtime-adapter.ts test/agents-runtime.test.ts test/delegation-verification.test.ts README.md
git commit -m "修復：協調迴圈不再驗證委派結果且每輪工作量有界"
```
