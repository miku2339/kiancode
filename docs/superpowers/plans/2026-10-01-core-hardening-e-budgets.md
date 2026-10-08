# Budgets and Token Estimation (Workstream E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-task and per-delegation model budgets operator-configurable, stop the token estimate from charging three "tokens" per CJK character, and make every budget failure say which budget ran out, in which dimension, at which limit and after how much use.

**Architecture:** One pure function `estimateTokens` replaces the two byte-length estimates (task reservation and daily quota). Because that estimate is no longer an upper bound, both ledgers (the private one inside `AgentRuntime` and the shared `BudgetLedger` of a delegation tree) raise `budget_violation` only when a cumulative limit is exceeded. A new strict `runtime.budgets` configuration block is threaded through `bootstrap` into `createTaskRunner` as a trailing optional parameter; nothing a client sends can change a budget.

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes), Node.js 24, zod 4 for configuration, `node:test` run through `tsx --test`, in-memory `SqliteStore` in tests.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section E)

## Global Constraints

- Node.js 24 or later. TypeScript with two-space indent, single quotes, semicolons and explicit public interfaces.
- Tests use `node:test` and run with `tsx --test`. Behaviour is tested through public interfaces. `npm run check` (typecheck, tests, build) passes before delivery.
- No new runtime dependencies.
- SQLite is for development and tests; PostgreSQL is production. Entities already stored in a deployed database must remain readable without a data rewrite. (This plan adds no entity field; `agent_budget` rows keep the limits they were created with.)
- Development authentication mode keeps its current behaviour.
- Errors are `DomainError(code, message, statusCode)` with snake_case codes. Existing codes and HTTP statuses do not change unless a workstream says so. (This plan changes message texts only: `token_budget_exceeded` 429, `call_budget_exceeded` 429, `budget_violation` 409, `budget_exceeded` 409, `invalid_budget` 400, `model_quota_exceeded` 429 keep their codes and statuses.)
- The distinction between dispatched, confirmed and unknown external outcomes is preserved. (Budget exhaustion is still detected before the provider is called.)
- No personal data, hostnames, secrets or production configuration in the repository.
- Line numbers in the plans refer to commit `17d571f`; function and symbol names are the stable anchors once earlier workstreams have landed.
- Execution order is G, A, C, B1, B2, D, E, F. This plan is applied after D. Every "existing lines" block below was checked against the tree with G, A, C, B1, B2 and D applied; where an earlier plan moved a line, the symbol named in the task is the anchor.
- Spec E1 values, exact: `runtime.budgets.task { maxCalls, maxTokens }` defaults 20 and 100000; `runtime.budgets.delegation { maxCalls, maxTokens }` defaults 24 and 128000; upper bounds 500 calls and 20000000 tokens; lower bound 1; no per-request override (pinned in Task 7 by `a request cannot carry a budget override`, `test/api.test.ts`).
- Spec E2 formula, exact: `estimateTokens(text) = ceil(asciiCodePoints / 4) + nonAsciiCodePoints`, iterating by code point.
- The outage fallback keeps its fixed budget (`maxCalls: 1, maxTokens: 16_000` in `src/bootstrap.ts`) and its wording is not specialised. Providers that report no usage keep today's behaviour (zero tokens charged to the task and delegation budgets).

## Review Focus

1. **A long CJK prompt.** A 60,000-character Chinese prompt on a default installation must reach the model instead of failing with `token_budget_exceeded` before dispatch. Pinned in Task 2 by `a 60,000-character CJK prompt is reserved per character and fits the default task budget` (`test/runtime.test.ts`).
2. **A provider that reports more tokens than one call reserved.** Dense ASCII, JSON or tool-call arguments make real usage exceed the estimate; while the cumulative budget holds the task must continue, not fail with `budget_violation`. Pinned in Task 3 by `provider usage above one call reservation is accepted while the task token budget holds` (`test/runtime.test.ts`) and `a model call may use more tokens than it reserved while the shared budget holds` (`test/agents-budget.test.ts`).
3. **An operator who overrides one number, or mistypes one.** `{ "runtime": { "budgets": { "task": { "maxTokens": 400000 } } } }` must keep every other default; `501` calls, `20000001` tokens, `0`, a string, or a misspelt key must fail at configuration load, not at 3 a.m. inside a task. Pinned in Task 6 by `runtime budgets accept partial overrides and survive the production transform` and `runtime budgets reject values outside 1..500 calls and 1..20000000 tokens, non-integers and unknown keys` (`test/config.test.ts`).
4. **The configured numbers silently not applying.** A raised budget must really reach the running task and both delegation entry points, and an absent block must still mean 20/100000 and 24/128000 (stored plan fingerprints depend on the delegation default). Pinned in Task 7 by `the task runner applies the configured task budget and keeps the runtime default without one` and `both delegation entry points create the shared ledger with the configured delegation budget` (`test/agents-runtime.test.ts`), and end to end in Task 10 by `bootstrap applies runtime.budgets from the configuration` (`test/bootstrap-runtime-budgets.test.ts`).
5. **A root task whose child ran out of budget.** The person sees only the root task; its error must carry the child's message, which must name the budget, the dimension, the limit and the amount used. Pinned in Task 8 by `a parent that failed because a child ran out of budget carries the child's message` (`test/agents-runtime.test.ts`); the message texts themselves are pinned in Task 4 by `task token budget exhaustion names the limit, the tokens used and the tokens the next request needs` (`test/runtime.test.ts`) and in Task 5 by `delegation budget exhaustion names the dimension, the limit, and the used, reserved and requested amounts` (`test/agents-budget.test.ts`).

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/runtime/token-estimate.ts` | create | The single pure function `estimateTokens(text)`. |
| `src/runtime/index.ts` | modify | Re-export `estimateTokens` from `@kiancode/core/runtime`. |
| `src/runtime/agent-runtime.ts` | modify | Input reservation uses `estimateTokens`; the private `BudgetLedger` raises a violation only on the cumulative limit and produces the `Task …` messages. |
| `src/agents/budget-ledger.ts` | modify | Shared ledger: cumulative-only violation rule and the `Delegation …` messages, through two module-private helpers. |
| `src/config.ts` | modify | The strict `runtime.budgets` block with defaults and bounds. |
| `deploy/config.example.json` | modify | Shows the block with its default values. |
| `src/runtime-adapter.ts` | modify | `TaskRunnerBudgets`, the trailing `budgets` parameter of `createTaskRunner`, both delegation sites, and the child's error text in the parent failure. |
| `src/bootstrap.ts` | modify | Passes `config.runtime.budgets` to `createTaskRunner`. |
| `src/model-management.ts` | modify | Daily quota reservation uses `estimateTokens` over the same serialized request instead of its UTF-8 byte length. |
| `README.md` | modify | Documents `runtime.budgets`, the estimate, the two budget names in failure messages and the rollback note. |
| `test/runtime-token-estimate.test.ts` | create | Unit tests of `estimateTokens`. |
| `test/runtime.test.ts` | modify | Runtime reservation, violation rule and `Task …` messages (one pinned value changes, new tests are appended). |
| `test/agents-budget.test.ts` | modify | Shared-ledger violation rule and `Delegation …` messages (appended). |
| `test/config.test.ts` | modify | `runtime.budgets` defaults, partial overrides, bounds, strictness (appended). |
| `test/agents-runtime.test.ts` | modify | `createTaskRunner` budgets and the parent failure text (appended). |
| `test/api.test.ts` | modify | Guard: a request body cannot carry a budget (appended). |
| `test/bootstrap-runtime-budgets.test.ts` | create | Configuration → `bootstrap` → task failure text and delegation ledger limits. |
| `test/model-management.test.ts` | modify | Daily quota reservation no longer scales with UTF-8 bytes (appended). |

Run every command from the repository root. `npx tsx --test test/<file>.test.ts` runs one file; `npx tsx --test --test-name-pattern='<substring>' test/<file>.test.ts` runs one test. `tsx` does not typecheck, so tasks that change a signature also run `npx tsc --noEmit`.

---

### Task 1: `estimateTokens` pure function

**Files:**
- Create: `src/runtime/token-estimate.ts`
- Modify: `src/runtime/index.ts` (the `VisualContextStore` value export, line 4 as of commit 17d571f; B2 adds an `export type { ToolCallReconciliation }` line above it, so anchor on the text of the line)
- Test: `test/runtime-token-estimate.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function estimateTokens(text: string): number` in `src/runtime/token-estimate.ts`, re-exported from `src/runtime/index.ts` (package path `@kiancode/core/runtime`). Returns `Math.ceil(A / 4) + N` where `A` is the number of code points below U+0080 and `N` the number of code points at or above U+0080; a surrogate pair is one code point, a lone surrogate counts as one non-ASCII code point, `''` returns `0`. Used by Tasks 2, 3 and 9.

- [ ] **Step 1: Write the failing test**

Create `test/runtime-token-estimate.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../src/runtime/index.js';

test('estimateTokens charges one token per four ASCII code points, rounded up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens('\n\t\r '), 1);
  assert.equal(estimateTokens('\u007f'), 1);
});

test('estimateTokens charges one token per non-ASCII code point', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('\u0080'), 1);
  assert.equal(estimateTokens('é'), 1);
  assert.equal(estimateTokens('ＡＢ'), 2);
  const long = '海'.repeat(60_000);
  assert.equal(Buffer.byteLength(long, 'utf8'), 180_000);
  assert.equal(estimateTokens(long), 60_000);
});

test('estimateTokens sums the ASCII share and the non-ASCII share of mixed text', () => {
  assert.equal(estimateTokens('Kian 你好'), 4);
  assert.equal(estimateTokens('café'), 2);
  assert.equal(estimateTokens('e\u0301'), 2);
  assert.equal(estimateTokens('\u007f\u007f\u007f\u007f\u0080'), 2);
});

test('estimateTokens iterates by code point, so a surrogate pair counts once and a lone surrogate does not throw', () => {
  assert.equal('\u{1F600}'.length, 2);
  assert.equal(estimateTokens('\u{1F600}'), 1);
  assert.equal(estimateTokens('\u{1F600}\u{1F600}'), 2);
  assert.equal(estimateTokens('\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'), 5);
  assert.equal(estimateTokens('\ud83d'), 1);
  assert.equal(estimateTokens('\ude00\ud83d'), 2);
});

test('estimateTokens is deterministic and returns a safe integer for a large mixed string', () => {
  const text = 'abc 海\u{1F600}'.repeat(150_000);
  const first = estimateTokens(text);
  assert.equal(first, estimateTokens(text));
  assert.equal(Number.isSafeInteger(first), true);
  assert.equal(first, Math.ceil((4 * 150_000) / 4) + 2 * 150_000);
});
```

Two literals are written with escapes on purpose, because the characters are invisible and an editor may normalise them away: `'e\u0301'` is the letter `e` followed by a combining acute accent (one ASCII and one non-ASCII code point, unlike the single code point `'é'` used a few lines above), and `\u200d` is the zero-width joiner between the three emoji. Keep the escapes.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/runtime-token-estimate.test.ts`

Expected: the file fails to load with

```
SyntaxError: The requested module '../src/runtime/index.js' does not provide an export named 'estimateTokens'
```

and the summary shows `ℹ pass 0`, `ℹ fail 1`.

- [ ] **Step 3: Write minimal implementation**

Create `src/runtime/token-estimate.ts`:

```ts
/**
 * Estimates how many model tokens a text occupies without a tokenizer:
 * four ASCII code points per token (rounded up) plus one token for every
 * non-ASCII code point. It is an estimate, not an upper bound; usage
 * reported by a provider replaces it.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 0x80) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 4) + nonAscii;
}
```

In `src/runtime/index.ts` find this existing line:

```ts
export { VisualContextStore } from './visual-context.js';
```

and add one line directly below it:

```ts
export { VisualContextStore } from './visual-context.js';
export { estimateTokens } from './token-estimate.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/runtime-token-estimate.test.ts`

Expected: `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/token-estimate.ts src/runtime/index.ts test/runtime-token-estimate.test.ts
git commit -m "實現：以碼位估算 token 數量的 estimateTokens"
```

---

### Task 2: Runtime input reservation uses `estimateTokens`

**Files:**
- Modify: `src/runtime/agent-runtime.ts` (import block lines 3-16 and `runSingle`, the `inputReservation` statement at lines 260-261 as of commit 17d571f)
- Test: `test/runtime.test.ts` (import block lines 5-10, the test `enforces model call and token budgets` at lines 401-460, and new tests appended at the end of the file)

**Interfaces:**
- Consumes: `estimateTokens(text: string): number` from Task 1.
- Produces: no new symbol. Behaviour: `inputReservation = Σ over messages (estimateTokens(message.content) + attachments × 16_384) + estimateTokens(JSON.stringify(tools as { name, description, inputSchema }))`. The `model_call` event's `reservedTokens` keeps its meaning (input reservation plus the output cap). The test helper `reservedTokensOf(events)` added here is reused by Task 3.

- [ ] **Step 1: Write the failing test**

In `test/runtime.test.ts` replace the import of the runtime module. Existing lines:

```ts
import {
  AgentRuntime,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
} from '../src/runtime/index.js';
```

Replacement:

```ts
import {
  AgentRuntime,
  estimateTokens,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type RuntimeEvent,
} from '../src/runtime/index.js';
```

In the existing test `enforces model call and token budgets` the output cap is pinned. The prompt `'answer'` used to reserve 6 bytes plus 2 bytes for `[]`; it now reserves `ceil(6 / 4) + ceil(2 / 4) = 3` tokens, so with `maxTokens: 10` the cap becomes 7. Existing line:

```ts
  assert.equal(tokenProvider.calls[0]?.maxOutputTokens, 2);
```

Replacement:

```ts
  assert.equal(tokenProvider.calls[0]?.maxOutputTokens, 7);
```

Append at the end of `test/runtime.test.ts`:

```ts

function reservedTokensOf(events: RuntimeEvent[]): Array<number | undefined> {
  return events.flatMap((event) => event.type === 'model_call' ? [event.reservedTokens] : []);
}

test('a 60,000-character CJK prompt is reserved per character and fits the default task budget', async () => {
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: '收到。' },
    usage: { inputTokens: 60_000, outputTokens: 3 },
  }]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'text-only', providerId: provider.id, locality: 'local', capabilities: [] }],
  });
  const events: RuntimeEvent[] = [];

  const result = await runtime.run({
    principal,
    taskId: 'cjk-context',
    prompt: '海'.repeat(60_000),
    mode: 'ask',
    strategy: 'single',
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(result.content, '收到。');
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.maxOutputTokens, 4096);
  assert.deepEqual(reservedTokensOf(events), [60_000 + 1 + 4096]);
});

test('input reservation estimates every message separately and adds attachments and tool schemas', async () => {
  const answer = (): ChatResponse => ({
    message: { role: 'assistant', content: 'ok' },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const readTool: ToolDefinition = {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { return { content: 'data' }; },
  };
  const reserve = async (
    capabilities: string[],
    input: Partial<Parameters<AgentRuntime['run']>[0]>,
    tools: ToolDefinition[] = [],
  ): Promise<number | undefined> => {
    const provider = new ScriptedProvider([answer()]);
    const runtime = new AgentRuntime({
      providers: [provider],
      models: [{ id: 'model', providerId: provider.id, locality: 'local', capabilities }],
      tools,
    });
    const events: RuntimeEvent[] = [];
    await runtime.run({
      principal,
      taskId: 'reservation',
      mode: 'ask',
      strategy: 'single',
      onEvent: (event) => { events.push(event); },
      ...input,
    });
    return reservedTokensOf(events)[0];
  };
  const noTools = estimateTokens('[]');
  assert.equal(noTools, 1);

  assert.equal(await reserve([], { prompt: 'a'.repeat(400) }), 100 + noTools + 4096);
  assert.equal(await reserve([], {
    profile: { systemPrompt: 'ab' },
    messages: [{ role: 'user', content: 'ab' }],
    prompt: 'ab',
  }), 3 + noTools + 4096);
  assert.equal(await reserve(['vision'], {
    requiredModelCapabilities: ['vision'],
    messages: [{
      role: 'user',
      content: 'abcd',
      attachments: [{ mimeType: 'image/png', data: 'AAAA' }, { mimeType: 'image/png', data: 'BBBB' }],
    }],
  }), 1 + 2 * 16_384 + noTools + 4096);
  const schema = JSON.stringify([{ name: readTool.name, description: readTool.description, inputSchema: readTool.inputSchema }]);
  assert.equal(
    await reserve(['tools'], { prompt: 'abcd' }, [readTool]),
    1 + estimateTokens(schema) + 4096,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='enforces model call and token budgets|CJK prompt is reserved|input reservation estimates' test/runtime.test.ts`

Expected: `ℹ tests 3`, `ℹ pass 0`, `ℹ fail 3` with these three reasons:

```
✖ enforces model call and token budgets
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 7

✖ a 60,000-character CJK prompt is reserved per character and fits the default task budget
  Error [DomainError]: No token budget remains for this model request.
    code: 'token_budget_exceeded',
    statusCode: 429,

✖ input reservation estimates every message separately and adds attachments and tool schemas
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  4498 !== 4197
```

- [ ] **Step 3: Write minimal implementation**

In `src/runtime/agent-runtime.ts` add the import directly below the type import from `./types.js`. Existing lines (the end of that import):

```ts
  ToolCall,
} from './types.js';
```

Replacement:

```ts
  ToolCall,
} from './types.js';
import { estimateTokens } from './token-estimate.js';
```

In `runSingle`, at the top of the `while (true)` loop, existing lines:

```ts
      const inputReservation = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + (message.attachments?.length ?? 0) * 16_384, 0)
        + Buffer.byteLength(JSON.stringify(modelTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))));
```

Replacement:

```ts
      const inputReservation = messages.reduce((sum, message) => sum + estimateTokens(message.content) + (message.attachments?.length ?? 0) * 16_384, 0)
        + estimateTokens(JSON.stringify(modelTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))));
```

Leave the rest of the loop alone: the `16_384` per attachment, the output clamp (`input.maxOutputTokens ?? 4096`, hard maximum `16_384`) and the order "pre-check, `reserveCall`, `model_call` event, provider call" do not change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/runtime.test.ts && npx tsc --noEmit`

Expected: every test in the file passes (`ℹ fail 0`; 31 tests when G, A, C, B1, B2 and D are applied) and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/agent-runtime.ts test/runtime.test.ts
git commit -m "修復：模型請求的輸入預留改用 estimateTokens，不再按位元組計算"
```

---

### Task 3: A violation is raised only when a cumulative limit is exceeded

**Files:**
- Modify: `src/runtime/agent-runtime.ts` (`runSingle`, the `addTokens` call at line 289, and the private class `BudgetLedger`, method `addTokens` at lines 637-643 as of commit 17d571f)
- Modify: `src/agents/budget-ledger.ts` (`BudgetLedger.chargeModelUsage`, the `violation` expression at lines 232-235 as of commit 17d571f)
- Test: `test/runtime.test.ts` (append), `test/agents-budget.test.ts` (append)

**Interfaces:**
- Consumes: `estimateTokens` (Task 1) and the test helper `reservedTokensOf(events: RuntimeEvent[]): Array<number | undefined>` added to `test/runtime.test.ts` in Task 2.
- Produces: no new symbol. Behaviour: the runtime raises `budget_violation` (409) after a provider response only when `usage.totalTokens > maxTokens`; the shared ledger's `chargeModelUsage` records a violation only when the charge exceeds the reserved call count or pushes `used + in-flight reservations + charge` above `limits.maxCalls` or `limits.maxTokens`. A call that uses more tokens than it reserved is otherwise charged in full and accepted. The private method becomes `addTokens(tokens: { inputTokens: number; outputTokens: number }): boolean`.

Why: before Task 2 the byte estimate was three to four times real usage, so "reported usage > this call's reservation" could never happen with an honest provider. With a realistic estimate it happens routinely (dense JSON, tool-call arguments, chat-template overhead), and no configuration could fix the resulting failure.

- [ ] **Step 1: Write the failing test**

Append at the end of `test/runtime.test.ts`:

```ts

test('provider usage above one call reservation is accepted while the task token budget holds', async () => {
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'dense answer' },
    usage: { inputTokens: 150, outputTokens: 5 },
  }]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'text-only', providerId: provider.id, locality: 'local', capabilities: [] }],
  });
  const events: RuntimeEvent[] = [];

  const result = await runtime.run({
    principal,
    taskId: 'call-overrun-within-budget',
    prompt: 'x'.repeat(400),
    mode: 'ask',
    strategy: 'single',
    budgets: { maxTokens: 10_000 },
    maxOutputTokens: 5,
    onEvent: (event) => { events.push(event); },
  });

  assert.deepEqual(reservedTokensOf(events), [100 + 1 + 5]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, { calls: 1, inputTokens: 150, outputTokens: 5, totalTokens: 155 });
});

test('after a call overrun the next output cap comes from the tokens the provider really used', async () => {
  const readTool: ToolDefinition = {
    name: 'read',
    description: 'Read',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { return { content: 'data' }; },
  };
  const schemaTokens = estimateTokens(JSON.stringify([{
    name: readTool.name, description: readTool.description, inputSchema: readTool.inputSchema,
  }]));
  const secondInput = estimateTokens('x'.repeat(400)) + estimateTokens('') + estimateTokens('data') + schemaTokens;
  const provider = new ScriptedProvider([
    {
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: {} }] },
      usage: { inputTokens: 190, outputTokens: 10 },
    },
    {
      message: { role: 'assistant', content: 'done' },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [readTool],
  });

  const result = await runtime.run({
    principal,
    taskId: 'remaining-after-overrun',
    prompt: 'x'.repeat(400),
    mode: 'ask',
    strategy: 'single',
    budgets: { maxTokens: 200 + secondInput + 3 },
    maxOutputTokens: 5,
  });

  assert.equal(result.content, 'done');
  assert.equal(provider.calls[0]?.maxOutputTokens, 5);
  assert.equal(provider.calls[1]?.maxOutputTokens, 3);
});

test('reported usage beyond the task token budget is recorded and then rejected', async () => {
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'large answer' },
    usage: { inputTokens: 7, outputTokens: 6 },
  }]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'text-only', providerId: provider.id, locality: 'local', capabilities: [] }],
  });
  const events: RuntimeEvent[] = [];

  await assert.rejects(
    runtime.run({
      principal,
      taskId: 'budget-overrun',
      prompt: 'answer',
      mode: 'ask',
      strategy: 'single',
      budgets: { maxTokens: 10 },
      maxOutputTokens: 1000,
      onEvent: (event) => { events.push(event); },
    }),
    (error: unknown) => error instanceof DomainError
      && error.code === 'budget_violation' && error.statusCode === 409,
  );
  const last = events.at(-1);
  assert.equal(last?.type, 'usage');
  assert.deepEqual(last?.type === 'usage' ? last.usage : undefined, {
    calls: 1, inputTokens: 7, outputTokens: 6, totalTokens: 13,
  });
});
```

Append at the end of `test/agents-budget.test.ts`:

```ts

test('a model call may use more tokens than it reserved while the shared budget holds', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'elastic-budget', 'root-task', { maxCalls: 2, maxTokens: 100 });
    await ledger.reserveModelCall('owner', 'elastic-budget', 'child', 1, 10);
    const charged = await ledger.chargeModelUsage('owner', 'elastic-budget', 'child', { calls: 1, totalTokens: 30 });
    assert.deepEqual(charged.used, { calls: 1, tokens: 30 });
    assert.deepEqual(charged.remaining, { calls: 1, tokens: 70 });
    assert.deepEqual(
      (await ledger.chargeModelUsage('owner', 'elastic-budget', 'child', { calls: 1, totalTokens: 30 })).used,
      { calls: 1, tokens: 30 },
    );
  } finally {
    await store.close();
  }
});

test('a model call overrun that collides with another in-flight reservation is a budget violation', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'collision-budget', 'root-task', { maxCalls: 3, maxTokens: 100 });
    await ledger.reserveModelCall('owner', 'collision-budget', 'child-a', 1, 10);
    await ledger.reserveModelCall('owner', 'collision-budget', 'child-b', 1, 60);
    await assert.rejects(
      ledger.chargeModelUsage('owner', 'collision-budget', 'child-a', { calls: 1, totalTokens: 50 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget_violation',
    );
    const snapshot = await ledger.get('owner', 'collision-budget');
    assert.deepEqual(snapshot.used, { calls: 1, tokens: 50 });
    assert.deepEqual(snapshot.reserved, { calls: 1, tokens: 60 });
  } finally {
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='above one call reservation|after a call overrun|recorded and then rejected|more tokens than it reserved|collides with another' test/runtime.test.ts test/agents-budget.test.ts`

Expected: `ℹ tests 5`, `ℹ pass 2`, `ℹ fail 3`. The two guard tests (`reported usage beyond the task token budget is recorded and then rejected` and `a model call overrun that collides with another in-flight reservation is a budget violation`) already pass and must keep passing; the three new-behaviour tests fail with:

```
✖ a model call may use more tokens than it reserved while the shared budget holds
  Error [DomainError]: Provider usage exceeded its reserved shared budget
    code: 'budget_violation',

✖ provider usage above one call reservation is accepted while the task token budget holds
  Error [DomainError]: Provider reported usage beyond the reserved token budget.
    code: 'budget_violation',

✖ after a call overrun the next output cap comes from the tokens the provider really used
  Error [DomainError]: Provider reported usage beyond the reserved token budget.
    code: 'budget_violation',
```

- [ ] **Step 3: Write minimal implementation**

In `src/runtime/agent-runtime.ts`, `runSingle`, existing line:

```ts
      const budgetViolation = options.budget.addTokens(response.usage, reservedTokens);
```

Replacement:

```ts
      const budgetViolation = options.budget.addTokens(response.usage);
```

(`reservedTokens` stays in use two statements earlier for `reserveCall` and the `model_call` event.)

In the private class `BudgetLedger` at the bottom of the same file, existing lines:

```ts
  public addTokens(tokens: { inputTokens: number; outputTokens: number }, reservedTokens: number): boolean {
    this.usage.inputTokens += tokens.inputTokens;
    this.usage.outputTokens += tokens.outputTokens;
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;
    return tokens.inputTokens + tokens.outputTokens > reservedTokens
      || this.usage.totalTokens > this.maxTokens;
  }
```

Replacement:

```ts
  public addTokens(tokens: { inputTokens: number; outputTokens: number }): boolean {
    this.usage.inputTokens += tokens.inputTokens;
    this.usage.outputTokens += tokens.outputTokens;
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;
    return this.usage.totalTokens > this.maxTokens;
  }
```

In `src/agents/budget-ledger.ts`, `chargeModelUsage`, existing lines:

```ts
      const violation = charged.calls > reservation.requested.calls
        || charged.tokens > reservation.requested.tokens
        || record.used.calls + held.calls + charged.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + charged.tokens > record.limits.maxTokens;
```

Replacement:

```ts
      const violation = charged.calls > reservation.requested.calls
        || record.used.calls + held.calls + charged.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + charged.tokens > record.limits.maxTokens;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/runtime.test.ts test/agents-budget.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts && npx tsc --noEmit`

Expected: `ℹ fail 0` (56 tests when G, A, C, B1, B2 and D are applied) and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/agent-runtime.ts src/agents/budget-ledger.ts test/runtime.test.ts test/agents-budget.test.ts
git commit -m "修復：只有累計用量超出上限才視為預算違規"
```

---

### Task 4: Task budget exhaustion messages

**Files:**
- Modify: `src/runtime/agent-runtime.ts` (`runSingle`: the `maxOutputTokens < 1` pre-check at lines 266-268 and the `budgetViolation` throw at lines 292-294; private class `BudgetLedger`: constructor at lines 601-617 and `reserveCall` at lines 623-635, as of commit 17d571f)
- Test: `test/runtime.test.ts` (append)

**Interfaces:**
- Consumes: the private runtime `BudgetLedger` with `addTokens(tokens)` as left by Task 3.
- Produces: two methods on the private runtime `BudgetLedger` — `tokensExhausted(needed: number): DomainError` and `tokensExceeded(): DomainError` — and these exact texts (codes and statuses unchanged). Tasks 7 and 10 assert on them.
  - `call_budget_exceeded` 429: `Task model call budget exhausted: limit <maxCalls>, used <calls>.`
  - `token_budget_exceeded` 429: `Task token budget exhausted: limit <maxTokens>, used <totalTokens>, next request needs at least <needed>.` (`needed` is the input reservation plus one output token at the pre-check, or the full reservation inside `reserveCall`)
  - `budget_violation` 409 on resume: `Task model call budget exceeded before resuming: limit <maxCalls>, used <calls>.` (checked first) or `Task token budget exceeded before resuming: limit <maxTokens>, used <totalTokens>.`
  - `budget_violation` 409 after a provider response: `Task token budget exceeded by reported provider usage: limit <maxTokens>, used <totalTokens>.`
  - `invalid_budget` 400 keeps `Runtime budgets must be positive safe integers.`

The messages contain fixed words and integers only; they are shown verbatim to end users through `task.error`. "Task" is the budget configured as `runtime.budgets.task` (Task 6); the outage fallback's fixed budget reads as a Task budget too and that wording is deliberately not specialised.

- [ ] **Step 1: Write the failing test**

Append at the end of `test/runtime.test.ts`:

```ts

function budgetError(code: string, statusCode: number, message: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.message, message);
    return true;
  };
}

function budgetFixture(responses: ChatResponse[]) {
  const provider = new ScriptedProvider(responses);
  const readTool: ToolDefinition = {
    name: 'read',
    description: 'Read',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { return { content: 'data' }; },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [readTool],
  });
  return { provider, runtime };
}

const readCall = (id: string): ChatResponse => ({
  message: { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: {} }] },
  usage: { inputTokens: 2, outputTokens: 1 },
});

test('task call budget exhaustion names the budget, the limit and the calls used', async () => {
  const configured = budgetFixture([readCall('read-1')]);
  await assert.rejects(
    configured.runtime.run({
      principal, taskId: 'call-limit', prompt: 'read', mode: 'ask', strategy: 'single', budgets: { maxCalls: 1 },
    }),
    budgetError('call_budget_exceeded', 429, 'Task model call budget exhausted: limit 1, used 1.'),
  );
  assert.equal(configured.provider.calls.length, 1);

  const defaults = budgetFixture(Array.from({ length: 20 }, (_, index) => readCall(`read-${index + 1}`)));
  await assert.rejects(
    defaults.runtime.run({ principal, taskId: 'default-call-limit', prompt: 'read', mode: 'ask', strategy: 'single' }),
    budgetError('call_budget_exceeded', 429, 'Task model call budget exhausted: limit 20, used 20.'),
  );
  assert.equal(defaults.provider.calls.length, 20);

  const resumed = budgetFixture([]);
  await assert.rejects(
    resumed.runtime.run({
      principal, taskId: 'call-limit-resumed', prompt: 'read', mode: 'ask', strategy: 'single',
      budgets: { maxCalls: 3 },
      priorUsage: { calls: 3, inputTokens: 6, outputTokens: 3, totalTokens: 9 },
    }),
    budgetError('call_budget_exceeded', 429, 'Task model call budget exhausted: limit 3, used 3.'),
  );
  assert.equal(resumed.provider.calls.length, 0);
});

test('task token budget exhaustion names the limit, the tokens used and the tokens the next request needs', async () => {
  const fresh = new ScriptedProvider([]);
  const freshRuntime = new AgentRuntime({
    providers: [fresh],
    models: [{ id: 'text-only', providerId: fresh.id, locality: 'local', capabilities: [] }],
  });
  await assert.rejects(
    freshRuntime.run({
      principal, taskId: 'token-limit', prompt: '海'.repeat(60), mode: 'ask', strategy: 'single',
      budgets: { maxTokens: 50 },
    }),
    budgetError('token_budget_exceeded', 429, 'Task token budget exhausted: limit 50, used 0, next request needs at least 62.'),
  );
  assert.equal(fresh.calls.length, 0);

  await assert.rejects(
    freshRuntime.run({
      principal, taskId: 'token-limit-resumed', prompt: 'x'.repeat(40), mode: 'ask', strategy: 'single',
      budgets: { maxTokens: 100 },
      priorUsage: { calls: 3, inputTokens: 90, outputTokens: 5, totalTokens: 95 },
    }),
    budgetError('token_budget_exceeded', 429, 'Task token budget exhausted: limit 100, used 95, next request needs at least 12.'),
  );
  assert.equal(fresh.calls.length, 0);
});

test('usage stored above a lowered task budget is rejected on resume with the limit and the usage', async () => {
  const { provider, runtime } = budgetFixture([]);
  await assert.rejects(
    runtime.run({
      principal, taskId: 'lowered-tokens', prompt: 'continue', mode: 'ask', strategy: 'single',
      budgets: { maxTokens: 100 },
      priorUsage: { calls: 2, inputTokens: 140, outputTokens: 10, totalTokens: 150 },
    }),
    budgetError('budget_violation', 409, 'Task token budget exceeded before resuming: limit 100, used 150.'),
  );
  await assert.rejects(
    runtime.run({
      principal, taskId: 'lowered-calls', prompt: 'continue', mode: 'ask', strategy: 'single',
      budgets: { maxCalls: 3 },
      priorUsage: { calls: 5, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    budgetError('budget_violation', 409, 'Task model call budget exceeded before resuming: limit 3, used 5.'),
  );
  assert.equal(provider.calls.length, 0);
});

test('a provider overrun of the task token budget reports the limit and the tokens used', async () => {
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'large answer' },
    usage: { inputTokens: 7, outputTokens: 6 },
  }]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'text-only', providerId: provider.id, locality: 'local', capabilities: [] }],
  });
  await assert.rejects(
    runtime.run({
      principal, taskId: 'overrun-message', prompt: 'answer', mode: 'ask', strategy: 'single',
      budgets: { maxTokens: 10 }, maxOutputTokens: 1000,
    }),
    budgetError('budget_violation', 409, 'Task token budget exceeded by reported provider usage: limit 10, used 13.'),
  );
});

test('invalid task budgets are still rejected as invalid_budget', async () => {
  const { runtime } = budgetFixture([]);
  for (const budgets of [{ maxCalls: 0 }, { maxTokens: 1.5 }]) {
    await assert.rejects(
      runtime.run({ principal, taskId: 'invalid-budget', prompt: 'read', mode: 'ask', strategy: 'single', budgets }),
      budgetError('invalid_budget', 400, 'Runtime budgets must be positive safe integers.'),
    );
  }
});
```

The numbers in the token test: 60 CJK characters reserve 60, `[]` reserves 1, plus 1 output token = 62; 40 ASCII characters reserve 10, `[]` reserves 1, plus 1 = 12.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='task call budget exhaustion|task token budget exhaustion|lowered task budget|provider overrun of the task|invalid task budgets' test/runtime.test.ts`

Expected: `ℹ tests 5`, `ℹ pass 1`, `ℹ fail 4` (the `invalid_budget` guard already passes). The four failures show the old texts:

```
+ 'Model call budget of 1 was exhausted.'
- 'Task model call budget exhausted: limit 1, used 1.'

+ 'No token budget remains for this model request.'
- 'Task token budget exhausted: limit 50, used 0, next request needs at least 62.'

+ 'Prior usage already exceeds the runtime budget.'
- 'Task token budget exceeded before resuming: limit 100, used 150.'

+ 'Provider reported usage beyond the reserved token budget.'
- 'Task token budget exceeded by reported provider usage: limit 10, used 13.'
```

- [ ] **Step 3: Write minimal implementation**

All four edits are in `src/runtime/agent-runtime.ts`.

(a) `runSingle`, the pre-check. Existing lines:

```ts
      if (maxOutputTokens < 1) {
        throw new DomainError('token_budget_exceeded', 'No token budget remains for this model request.', 429);
      }
```

Replacement:

```ts
      if (maxOutputTokens < 1) {
        throw options.budget.tokensExhausted(inputReservation + 1);
      }
```

(b) `runSingle`, after the provider response. Existing lines:

```ts
      if (budgetViolation) {
        throw new DomainError('budget_violation', 'Provider reported usage beyond the reserved token budget.', 409);
      }
```

Replacement:

```ts
      if (budgetViolation) {
        throw options.budget.tokensExceeded();
      }
```

(c) Private class `BudgetLedger`, end of the constructor. Existing lines:

```ts
    if (this.usage.calls > this.maxCalls || this.usage.totalTokens > this.maxTokens) {
      throw new DomainError('budget_violation', 'Prior usage already exceeds the runtime budget.', 409);
    }
```

Replacement:

```ts
    if (this.usage.calls > this.maxCalls) {
      throw new DomainError(
        'budget_violation',
        `Task model call budget exceeded before resuming: limit ${this.maxCalls}, used ${this.usage.calls}.`,
        409,
      );
    }
    if (this.usage.totalTokens > this.maxTokens) {
      throw new DomainError(
        'budget_violation',
        `Task token budget exceeded before resuming: limit ${this.maxTokens}, used ${this.usage.totalTokens}.`,
        409,
      );
    }
```

(d) Private class `BudgetLedger`, method `reserveCall`. Existing lines:

```ts
  public reserveCall(tokens: number): void {
    if (this.usage.calls >= this.maxCalls) {
      throw new DomainError(
        'call_budget_exceeded',
        `Model call budget of ${this.maxCalls} was exhausted.`,
        429,
      );
    }
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > this.availableTokens()) {
      throw new DomainError('token_budget_exceeded', 'The model request does not fit the remaining token budget.', 429);
    }
    this.usage.calls += 1;
  }
```

Replacement (the method plus the two new methods directly below it):

```ts
  public reserveCall(tokens: number): void {
    if (this.usage.calls >= this.maxCalls) {
      throw new DomainError(
        'call_budget_exceeded',
        `Task model call budget exhausted: limit ${this.maxCalls}, used ${this.usage.calls}.`,
        429,
      );
    }
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > this.availableTokens()) {
      throw this.tokensExhausted(tokens);
    }
    this.usage.calls += 1;
  }

  public tokensExhausted(needed: number): DomainError {
    return new DomainError(
      'token_budget_exceeded',
      `Task token budget exhausted: limit ${this.maxTokens}, used ${this.usage.totalTokens}, next request needs at least ${needed}.`,
      429,
    );
  }

  public tokensExceeded(): DomainError {
    return new DomainError(
      'budget_violation',
      `Task token budget exceeded by reported provider usage: limit ${this.maxTokens}, used ${this.usage.totalTokens}.`,
      409,
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/runtime.test.ts && npx tsc --noEmit`

Expected: `ℹ fail 0` (39 tests when G, A, C, B1, B2 and D are applied) and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/agent-runtime.ts test/runtime.test.ts
git commit -m "修復：任務預算耗盡訊息列出預算名稱、維度、上限與已用量"
```

---

### Task 5: Delegation budget exhaustion messages

**Files:**
- Modify: `src/agents/budget-ledger.ts` (new module-private helpers after `reserved` at line 67; `BudgetLedger.reserve` lines 119-123; `BudgetLedger.charge` lines 153-157; `BudgetLedger.chargeModelUsage` lines 217-218 and 253; `BudgetLedger.adoptRuntimeUsage` lines 280-284, as of commit 17d571f)
- Test: `test/agents-budget.test.ts` (append)

**Interfaces:**
- Consumes: the shared `BudgetLedger` with the violation rule left by Task 3. Existing module-private helpers `zero()`, `reserved(record, except?)`, and the exported types `BudgetLedgerRecord`, `BudgetUnits`.
- Produces: two module-private helpers, `exhausted(record: BudgetLedgerRecord, held: BudgetUnits, requested: BudgetUnits): DomainError | undefined` and `overrun(record: BudgetLedgerRecord, reservationId: string): DomainError`, and these exact texts (codes and the 409 status unchanged; no trailing period, matching this file's style). Tasks 7 and 8 assert on them. Public method signatures of `BudgetLedger` do not change.
  - `budget_exceeded` from `reserve`, `charge`, `adoptRuntimeUsage` (calls are checked before tokens):
    `Delegation model call budget exhausted: limit <maxCalls>, used <used.calls>, reserved <held.calls>, requested <requested.calls>`
    `Delegation token budget exhausted: limit <maxTokens>, used <used.tokens>, reserved <held.tokens>, requested <requested.tokens>`
  - `budget_violation` from `chargeModelUsage` (values after the charge is recorded; a replay of the identical usage throws again with the ledger's values at the time of the replay, which are the same as long as nothing else was reserved or charged in between):
    `Delegation token budget exceeded by reported provider usage: limit <maxTokens>, used <used.tokens>, reserved <held.tokens>`
    `Delegation model call budget exceeded by reported provider usage: limit <maxCalls>, used <used.calls>, reserved <held.calls>`

`reserved` is the sum of reservations still in flight (other tasks of the same delegation tree that have asked for a model call and not yet reported usage). "Delegation" is the budget configured as `runtime.budgets.delegation` (Task 6).

- [ ] **Step 1: Write the failing test**

Append at the end of `test/agents-budget.test.ts`:

```ts

function ledgerError(code: string, message: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error && 'code' in error && 'statusCode' in error);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, message);
    return true;
  };
}

test('delegation budget exhaustion names the dimension, the limit, and the used, reserved and requested amounts', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'calls', 'root-task', { maxCalls: 2, maxTokens: 100 });
    for (const call of [1, 2]) {
      await ledger.reserveModelCall('owner', 'calls', 'child', call, 10);
      await ledger.chargeModelUsage('owner', 'calls', 'child', { calls: call, totalTokens: call * 5 });
    }
    const before = await ledger.get('owner', 'calls');
    await assert.rejects(
      ledger.reserveModelCall('owner', 'calls', 'child', 3, 10),
      ledgerError('budget_exceeded', 'Delegation model call budget exhausted: limit 2, used 2, reserved 0, requested 1'),
    );
    assert.equal((await ledger.get('owner', 'calls')).revision, before.revision);

    await ledger.create('owner', 'tokens', 'root-task', { maxCalls: 3, maxTokens: 100 });
    await ledger.reserve('owner', 'tokens', 'child-a:model:1', { calls: 1, tokens: 70 });
    await assert.rejects(
      ledger.reserve('owner', 'tokens', 'child-b:model:1', { calls: 1, tokens: 70 }),
      ledgerError('budget_exceeded', 'Delegation token budget exhausted: limit 100, used 0, reserved 70, requested 70'),
    );
    await assert.rejects(
      ledger.charge('owner', 'tokens', 'child-a:model:1', { calls: 1, tokens: 120 }),
      ledgerError('budget_exceeded', 'Delegation token budget exhausted: limit 100, used 0, reserved 0, requested 120'),
    );

    await ledger.create('owner', 'both', 'root-task', { maxCalls: 1, maxTokens: 10 });
    await ledger.reserve('owner', 'both', 'child-a:model:1', { calls: 1, tokens: 5 });
    await assert.rejects(
      ledger.reserve('owner', 'both', 'child-b:model:1', { calls: 1, tokens: 10 }),
      ledgerError('budget_exceeded', 'Delegation model call budget exhausted: limit 1, used 0, reserved 1, requested 1'),
    );

    await ledger.create('owner', 'adoption', 'root-task', { maxCalls: 3, maxTokens: 15 });
    await ledger.reserve('owner', 'adoption', 'child:model:1', { calls: 1, tokens: 5 });
    await assert.rejects(
      ledger.adoptRuntimeUsage('owner', 'adoption', 'root-task', { calls: 1, totalTokens: 11 }),
      ledgerError('budget_exceeded', 'Delegation token budget exhausted: limit 15, used 0, reserved 5, requested 11'),
    );
    assert.deepEqual((await ledger.get('owner', 'adoption')).used, { calls: 0, tokens: 0 });
  } finally {
    await store.close();
  }
});

test('a delegation budget violation names the limit and the recorded usage, also when the charge is replayed', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'violation', 'root-task', { maxCalls: 1, maxTokens: 10 });
    await ledger.reserveModelCall('owner', 'violation', 'child', 1, 10);
    const expected = ledgerError(
      'budget_violation',
      'Delegation token budget exceeded by reported provider usage: limit 10, used 12, reserved 0',
    );
    await assert.rejects(ledger.chargeModelUsage('owner', 'violation', 'child', { calls: 1, totalTokens: 12 }), expected);
    await assert.rejects(ledger.chargeModelUsage('owner', 'violation', 'child', { calls: 1, totalTokens: 12 }), expected);

    await ledger.create('owner', 'collision', 'root-task', { maxCalls: 3, maxTokens: 100 });
    await ledger.reserveModelCall('owner', 'collision', 'child-a', 1, 10);
    await ledger.reserveModelCall('owner', 'collision', 'child-b', 1, 60);
    await assert.rejects(
      ledger.chargeModelUsage('owner', 'collision', 'child-a', { calls: 1, totalTokens: 50 }),
      ledgerError(
        'budget_violation',
        'Delegation token budget exceeded by reported provider usage: limit 100, used 50, reserved 60',
      ),
    );

    await ledger.create('owner', 'uncounted-call', 'root-task', { maxCalls: 3, maxTokens: 100 });
    await ledger.reserve('owner', 'uncounted-call', 'child:model:1', { calls: 0, tokens: 10 });
    await assert.rejects(
      ledger.chargeModelUsage('owner', 'uncounted-call', 'child', { calls: 1, totalTokens: 5 }),
      ledgerError(
        'budget_violation',
        'Delegation model call budget exceeded by reported provider usage: limit 3, used 1, reserved 0',
      ),
    );
  } finally {
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='delegation budget exhaustion names|delegation budget violation names' test/agents-budget.test.ts`

Expected: `ℹ tests 2`, `ℹ pass 0`, `ℹ fail 2`, showing the old texts:

```
+ 'Shared orchestration budget is exhausted'
- 'Delegation model call budget exhausted: limit 2, used 2, reserved 0, requested 1'

+ 'Provider usage exceeded its reserved shared budget'
- 'Delegation token budget exceeded by reported provider usage: limit 10, used 12, reserved 0'
```

- [ ] **Step 3: Write minimal implementation**

All edits are in `src/agents/budget-ledger.ts`.

(a) Add the two helpers between the existing function `reserved` and the class. Existing lines:

```ts
    return total;
  }, zero());
}

export class BudgetLedger {
```

Replacement:

```ts
    return total;
  }, zero());
}

function exhausted(record: BudgetLedgerRecord, held: BudgetUnits, requested: BudgetUnits): DomainError | undefined {
  const { limits, used } = record;
  if (used.calls + held.calls + requested.calls > limits.maxCalls) {
    return new DomainError(
      'budget_exceeded',
      `Delegation model call budget exhausted: limit ${limits.maxCalls}, used ${used.calls}, reserved ${held.calls}, requested ${requested.calls}`,
      409,
    );
  }
  if (used.tokens + held.tokens + requested.tokens > limits.maxTokens) {
    return new DomainError(
      'budget_exceeded',
      `Delegation token budget exhausted: limit ${limits.maxTokens}, used ${used.tokens}, reserved ${held.tokens}, requested ${requested.tokens}`,
      409,
    );
  }
  return undefined;
}

function overrun(record: BudgetLedgerRecord, reservationId: string): DomainError {
  const { limits, used } = record;
  const held = reserved(record);
  const settled = record.reservations[reservationId];
  const calls = (settled?.charged?.calls ?? 0) > (settled?.requested.calls ?? 0)
    || used.calls + held.calls > limits.maxCalls;
  return new DomainError(
    'budget_violation',
    calls
      ? `Delegation model call budget exceeded by reported provider usage: limit ${limits.maxCalls}, used ${used.calls}, reserved ${held.calls}`
      : `Delegation token budget exceeded by reported provider usage: limit ${limits.maxTokens}, used ${used.tokens}, reserved ${held.tokens}`,
    409,
  );
}

export class BudgetLedger {
```

(b) `reserve`. Existing lines:

```ts
      const held = reserved(record);
      if (record.used.calls + held.calls + requested.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + requested.tokens > record.limits.maxTokens) {
        throw new DomainError('budget_exceeded', 'Shared orchestration budget is exhausted', 409);
      }
```

Replacement:

```ts
      const failure = exhausted(record, reserved(record), requested);
      if (failure) throw failure;
```

(c) `charge`. Existing lines:

```ts
      const held = reserved(record, reservationId);
      if (record.used.calls + held.calls + charged.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + charged.tokens > record.limits.maxTokens) {
        throw new DomainError('budget_exceeded', 'Reported usage exceeds the shared orchestration budget', 409);
      }
```

Replacement:

```ts
      const failure = exhausted(record, reserved(record, reservationId), charged);
      if (failure) throw failure;
```

(d) `chargeModelUsage`, the idempotent replay branch. Existing lines:

```ts
        const settled = record.reservations[`${taskId}:model:${usage.calls}`];
        if (settled?.violation) throw new DomainError('budget_violation', 'Provider usage exceeded its reserved shared budget', 409);
```

Replacement:

```ts
        const settledId = `${taskId}:model:${usage.calls}`;
        if (record.reservations[settledId]?.violation) throw overrun(record, settledId);
```

(e) `chargeModelUsage`, after the record is saved. Existing line:

```ts
        if (violation) throw new DomainError('budget_violation', 'Provider usage exceeded its reserved shared budget', 409);
```

Replacement:

```ts
        if (violation) throw overrun(next, reservationId);
```

(The `const held = reserved(record, reservationId);` statement a few lines above it stays; the `violation` expression from Task 3 still uses it.)

(f) `adoptRuntimeUsage`. Existing lines:

```ts
      const held = reserved(record);
      if (record.used.calls + held.calls + delta.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + delta.tokens > record.limits.maxTokens) {
        throw new DomainError('budget_exceeded', 'Existing parent usage exhausts the shared orchestration budget', 409);
      }
```

Replacement:

```ts
      const failure = exhausted(record, reserved(record), delta);
      if (failure) throw failure;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/agents-budget.test.ts test/agents-coordinator.test.ts test/agents-runtime.test.ts && npx tsc --noEmit`

Expected: `ℹ fail 0` (24 tests when G, A, C, B1, B2 and D are applied) and `tsc` prints nothing. The existing tests in these files assert on error codes only and need no edit.

- [ ] **Step 5: Commit**

```bash
git add src/agents/budget-ledger.ts test/agents-budget.test.ts
git commit -m "修復：委派預算耗盡訊息列出維度、上限、已用、保留與請求量"
```

---

### Task 6: Configuration block `runtime.budgets`

**Files:**
- Modify: `src/config.ts` (after the constant `defaultTerminalReadOnlyPaths` at line 7, and inside `configSchema` after the `plugins` block that ends at line 85, as of commit 17d571f; plan A inserts `levelCeilingSchema` and `auth.levelCeilings` above these places, so anchor on the quoted text)
- Modify: `deploy/config.example.json` (the `plugins` block at lines 40-43, the end of the file)
- Test: `test/config.test.ts` (append)

**Interfaces:**
- Consumes: in `test/config.test.ts`, the imports `readFile` from `node:fs/promises` and `ZodError` from `zod`. Plan A adds both (`import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';` and `import { ZodError } from 'zod';`). If either is missing when you start, add `import { readFile } from 'node:fs/promises';` and/or `import { ZodError } from 'zod';` to the import block at the top of the file.
- Produces: `Configuration['runtime']['budgets']` of type `{ task: { maxCalls: number; maxTokens: number }; delegation: { maxCalls: number; maxTokens: number } }`, always present after parsing. Defaults: task `20` / `100000`, delegation `24` / `128000`. Each number is an integer from `1` to `500` (calls) or `1` to `20000000` (tokens). Every level is strict (unknown keys are rejected). Task 10 passes `config.runtime.budgets` to `createTaskRunner`.

The block uses zod's `.prefault({})` instead of the fully spelled `.default({...})` used elsewhere in this file: `prefault` feeds `{}` through the inner schema, so the four default numbers are written once and every parse returns fresh objects. There is deliberately no rule tying the delegation budget to the task budget.

- [ ] **Step 1: Write the failing test**

Append at the end of `test/config.test.ts`:

```ts

test('runtime budgets default to the built-in task and delegation limits', () => {
  const defaults = {
    budgets: {
      task: { maxCalls: 20, maxTokens: 100000 },
      delegation: { maxCalls: 24, maxTokens: 128000 },
    },
  };
  assert.deepEqual(configSchema.parse({}).runtime, defaults);
  assert.deepEqual(configSchema.parse({ runtime: {} }).runtime, defaults);
  assert.deepEqual(configSchema.parse({ runtime: { budgets: {} } }).runtime, defaults);
  assert.deepEqual(configSchema.parse({ runtime: { budgets: { task: {}, delegation: {} } } }).runtime, defaults);

  const first = configSchema.parse({});
  first.runtime.budgets.task.maxCalls = 1;
  first.runtime.budgets.delegation.maxTokens = 1;
  assert.deepEqual(configSchema.parse({}).runtime, defaults);
});

test('runtime budgets accept partial overrides and survive the production transform', async () => {
  const partial = configSchema.parse({ runtime: { budgets: { task: { maxTokens: 400000 } } } });
  assert.deepEqual(partial.runtime.budgets, {
    task: { maxCalls: 20, maxTokens: 400000 },
    delegation: { maxCalls: 24, maxTokens: 128000 },
  });

  const production = configSchema.parse({
    mode: 'production',
    auth: { mode: 'account', issuer: 'https://account.example.com' },
    attachments: { url: 'https://storage.example.com' },
    runtime: { budgets: { task: { maxCalls: 500, maxTokens: 20000000 }, delegation: { maxCalls: 500, maxTokens: 20000000 } } },
  });
  assert.equal(production.stateDirectory, '/var/lib/kiancode');
  assert.deepEqual(production.runtime.budgets, {
    task: { maxCalls: 500, maxTokens: 20000000 },
    delegation: { maxCalls: 500, maxTokens: 20000000 },
  });

  const example = JSON.parse(await readFile(new URL('../deploy/config.example.json', import.meta.url), 'utf8')) as {
    runtime?: unknown;
  };
  assert.deepEqual(example.runtime, {
    budgets: {
      task: { maxCalls: 20, maxTokens: 100000 },
      delegation: { maxCalls: 24, maxTokens: 128000 },
    },
  });
  assert.deepEqual(configSchema.parse(example).runtime, example.runtime);
});

test('runtime budgets reject values outside 1..500 calls and 1..20000000 tokens, non-integers and unknown keys', () => {
  const rejectedAt = (input: unknown, issuePath: string[]): void => {
    assert.throws(
      () => configSchema.parse(input),
      (error: unknown) => error instanceof ZodError
        && error.issues.some((issue) => issue.path.join('.') === issuePath.join('.')),
      `${JSON.stringify(input)} must be rejected at ${issuePath.join('.')}`,
    );
  };
  for (const block of ['task', 'delegation'] as const) {
    for (const [field, value] of [
      ['maxCalls', 0], ['maxCalls', -1], ['maxCalls', 501], ['maxCalls', 1.5], ['maxCalls', '20'], ['maxCalls', null],
      ['maxTokens', 0], ['maxTokens', -1], ['maxTokens', 20000001], ['maxTokens', 1.5], ['maxTokens', '100000'],
      ['maxTokens', null], ['maxTokens', 1e21],
    ] as const) {
      rejectedAt({ runtime: { budgets: { [block]: { [field]: value } } } }, ['runtime', 'budgets', block, field]);
    }
    assert.deepEqual(
      configSchema.parse({ runtime: { budgets: { [block]: { maxCalls: 1, maxTokens: 1 } } } }).runtime.budgets[block],
      { maxCalls: 1, maxTokens: 1 },
    );
    rejectedAt({ runtime: { budgets: { [block]: { maxToken: 1 } } } }, ['runtime', 'budgets', block]);
  }
  rejectedAt({ runtime: { budget: {} } }, ['runtime']);
  rejectedAt({ runtime: { budgets: { tasks: {} } } }, ['runtime', 'budgets']);
  rejectedAt({ runtime: { budgets: { task: { maxCalls: 5 }, perRequest: true } } }, ['runtime', 'budgets']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='runtime budgets' test/config.test.ts`

Expected: `ℹ tests 3`, `ℹ pass 0`, `ℹ fail 3`:

```
✖ runtime budgets default to the built-in task and delegation limits
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + undefined
  - {
  -   budgets: {

✖ runtime budgets accept partial overrides and survive the production transform
  ZodError: [
    {
      "code": "unrecognized_keys",
      "keys": [
        "runtime"
      ],
      "path": [],
      "message": "Unrecognized key: \"runtime\""
    }
  ]

✖ runtime budgets reject values outside 1..500 calls and 1..20000000 tokens, non-integers and unknown keys
  AssertionError [ERR_ASSERTION]: {"runtime":{"budgets":{"task":{"maxCalls":0}}}} must be rejected at runtime.budgets.task.maxCalls
```

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, existing line:

```ts
const defaultTerminalReadOnlyPaths = ['/usr'];
```

Replacement:

```ts
const defaultTerminalReadOnlyPaths = ['/usr'];
const budgetSchema = (maxCalls: number, maxTokens: number) => z.object({
  maxCalls: z.number().int().min(1).max(500).default(maxCalls),
  maxTokens: z.number().int().min(1).max(20_000_000).default(maxTokens),
}).strict().prefault({});
```

In the same file, the end of the object passed to `configSchema`. Existing lines:

```ts
  }).strict().default({ allowedOrigins: [], allowedCommands: [], commandProfiles: [] }),
}).strict().superRefine((config, context) => {
```

Replacement:

```ts
  }).strict().default({ allowedOrigins: [], allowedCommands: [], commandProfiles: [] }),
  runtime: z.object({
    budgets: z.object({
      task: budgetSchema(20, 100_000),
      delegation: budgetSchema(24, 128_000),
    }).strict().prefault({}),
  }).strict().prefault({}),
}).strict().superRefine((config, context) => {
```

In `deploy/config.example.json`, the end of the file. Existing lines:

```json
  "plugins": {
    "allowedOrigins": [],
    "commandProfiles": []
  }
}
```

Replacement:

```json
  "plugins": {
    "allowedOrigins": [],
    "commandProfiles": []
  },
  "runtime": {
    "budgets": {
      "task": { "maxCalls": 20, "maxTokens": 100000 },
      "delegation": { "maxCalls": 24, "maxTokens": 128000 }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/config.test.ts && npx tsc --noEmit`

Expected: `ℹ fail 0` (15 tests when G, A, C, B1, B2 and D are applied) and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts deploy/config.example.json test/config.test.ts
git commit -m "實現：新增 runtime.budgets 設定區塊與上下限驗證"
```

---

### Task 7: `createTaskRunner` applies the task and delegation budgets

**Files:**
- Modify: `src/runtime-adapter.ts` (module-private `delegateTool`: signature at lines 52-58 and the `budget` literal at line 102; `createTaskRunner`: signature at lines 123-130, the experts/MoA `coordinator.prepare` call at lines 181-182, the `delegateTool(...)` call at line 266 and the `runtime.run({...})` call at lines 268-280, as of commit 17d571f. Plan D inserts `integrationPrompt` above `createTaskRunner` and `verifyIntegration` inside it; none of the quoted lines change, anchor on their text)
- Test: `test/agents-runtime.test.ts` (import block lines 1-9, and new tests appended at the end), `test/api.test.ts` (one guard test appended at the end; it uses the file's existing `token`, `headers`, `createServer`, `developmentAuth` and `SqliteStore`)

**Interfaces:**
- Consumes: the `Task …` messages from Task 4 and the `Delegation …` messages from Task 5. Existing: `AgentCoordinator.prepare(ownerId, parentTaskId, request, options?)` whose `request.budget` is `{ maxCalls: number; maxTokens: number }`; `coordinator.budgets.get(ownerId, budgetId): Promise<BudgetSnapshot>` with `limits` and `used`; `RunInput.budgets?: RunBudgets`.
- Produces (exported from `src/runtime-adapter.ts`, therefore from the package root):

```ts
export interface TaskRunnerBudgets {
  task?: { maxCalls: number; maxTokens: number };
  delegation?: { maxCalls: number; maxTokens: number };
}

export function createTaskRunner(
  store: Store,
  runtime: Pick<AgentRuntime, 'run'>,
  tools: ToolDefinition[],
  artifacts?: ArtifactService,
  coordinator?: AgentCoordinator,
  visualContexts?: VisualContextStore,
  budgets: TaskRunnerBudgets = {},
): TaskRunner;
```

  `budgets.task`, when present, is passed as `RunInput.budgets` on every run of every task (root, child and integration runs alike; it is cumulative because the stored `task.usage` is passed as `priorUsage`). `budgets.delegation` (default `{ maxCalls: 24, maxTokens: 128_000 }`) is the limit a new shared ledger is created with, at both entry points: the `agent.delegate` tool of a root task and the experts/MoA fan-out. The first six parameters and the behaviour without the seventh are unchanged. Task 10 passes `config.runtime.budgets`.

The delegation default must stay exactly 24 / 128000 when nothing is configured: `request.budget` is hashed into the stored plan fingerprint, and a replayed `prepare` with different numbers fails with `idempotency_conflict`. The test helper `runDelegation` added here is reused by Task 8.

- [ ] **Step 1: Write the failing test**

In `test/agents-runtime.test.ts` change two import lines. Existing lines:

```ts
import { createTaskRunner, reconcileAgentTasks } from '../src/runtime-adapter.js';
```

```ts
import { DomainError } from '../src/contracts.js';
```

Replacements:

```ts
import { createTaskRunner, reconcileAgentTasks, type TaskRunnerBudgets } from '../src/runtime-adapter.js';
```

```ts
import { DomainError, type ToolDefinition } from '../src/contracts.js';
```

Append at the end of `test/agents-runtime.test.ts`:

```ts

test('the task runner applies the configured task budget and keeps the runtime default without one', async () => {
  const run = async (budgets?: TaskRunnerBudgets): Promise<{ task: Task; providerCalls: number }> => {
    const store = new SqliteStore();
    let providerCalls = 0;
    const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat() {
      providerCalls += 1;
      return providerCalls === 1
        ? {
          message: { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: {} }] },
          usage: { inputTokens: 5, outputTokens: 3 },
        }
        : { message: { role: 'assistant', content: 'Read and answered.' }, usage: { inputTokens: 5, outputTokens: 3 } };
    } };
    const readTool: ToolDefinition = {
      name: 'read',
      description: 'Read',
      inputSchema: { type: 'object' },
      requiredCapabilities: [],
      sideEffect: 'read',
      async execute() { return { content: 'data' }; },
    };
    const runtime = new AgentRuntime({
      providers: [provider],
      models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming', 'tools'] }],
      tools: [readTool],
    });
    const runner = budgets
      ? createTaskRunner(store, runtime, [], undefined, undefined, undefined, budgets)
      : createTaskRunner(store, runtime, []);
    const tasks = new TaskService(store, runner, { reauthorize: async (current) => current });
    try {
      const conversation = await store.create<Conversation>('conversation', principal.id, {
        title: 'Budget', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
      });
      const task = await tasks.enqueue(principal, conversation.id, 'Read the data');
      await tasks.drain();
      return { task: (await store.get<Task>('task', task.id, principal.id))!.data, providerCalls };
    } finally { await tasks.close(); await store.close(); }
  };

  const limited = await run({ task: { maxCalls: 1, maxTokens: 100_000 } });
  assert.equal(limited.task.state, 'failed');
  assert.equal(limited.task.error, 'Task model call budget exhausted: limit 1, used 1.');
  assert.equal(limited.providerCalls, 1);

  const tokenLimited = await run({ task: { maxCalls: 20, maxTokens: 50 } });
  assert.equal(tokenLimited.task.state, 'failed');
  assert.match(tokenLimited.task.error!, /^Task token budget exhausted: limit 50, used 0, next request needs at least \d+\.$/);
  assert.equal(tokenLimited.providerCalls, 0);

  const unconfigured = await run();
  assert.equal(unconfigured.task.state, 'completed', unconfigured.task.error);
  assert.equal(unconfigured.providerCalls, 2);

  const delegationOnly = await run({ delegation: { maxCalls: 1, maxTokens: 1 } });
  assert.equal(delegationOnly.task.state, 'completed', delegationOnly.task.error);
  assert.equal(delegationOnly.providerCalls, 2);
});

async function runDelegation(
  strategy: 'single' | 'moa',
  budgets?: TaskRunnerBudgets,
): Promise<{ root: Task; limits: { maxCalls: number; maxTokens: number }; used: { calls: number; tokens: number }; providerCalls: number }> {
  const store = new SqliteStore();
  let rootId = '';
  let providerCalls = 0;
  const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat(request) {
    providerCalls += 1;
    if (request.context!.taskId === rootId && request.tools.some((tool) => tool.name === 'agent.delegate')) {
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'delegate-once', name: 'agent.delegate', arguments: { prompt: 'Inspect independently.', childKey: 'worker' } }],
        },
        usage: { inputTokens: 10, outputTokens: 4 },
      };
    }
    return { message: { role: 'assistant', content: 'Supported answer.' }, usage: { inputTokens: 8, outputTokens: 5 } };
  } };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming', 'tools'] }],
  });
  const coordinator = new AgentCoordinator(store);
  const runner = budgets
    ? createTaskRunner(store, runtime, [], undefined, coordinator, undefined, budgets)
    : createTaskRunner(store, runtime, [], undefined, coordinator);
  const tasks = new TaskService(store, runner, { reauthorize: async (current) => current });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Delegation budget', scope: 'private', modelPolicy: 'cloud', strategy, mode: 'ask', archived: false,
    });
    const root = await tasks.enqueue(principal, conversation.id, 'Research this');
    rootId = root.id;
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    await tasks.drain();
    const plan = (await store.scan<OrchestrationPlan>('agent_plan', principal.id))[0]!;
    const ledger = await coordinator.budgets.get(principal.id, plan.data.budgetId);
    return {
      root: (await store.get<Task>('task', root.id, principal.id))!.data,
      limits: ledger.limits,
      used: ledger.used,
      providerCalls,
    };
  } finally { await tasks.close(); await store.close(); }
}

test('both delegation entry points create the shared ledger with the configured delegation budget', async () => {
  const configured = { delegation: { maxCalls: 7, maxTokens: 90_000 } };
  for (const strategy of ['single', 'moa'] as const) {
    const withBudget = await runDelegation(strategy, configured);
    assert.deepEqual(withBudget.limits, { maxCalls: 7, maxTokens: 90000 }, strategy);
    assert.equal(withBudget.root.state, 'completed', withBudget.root.error);

    const withoutBudget = await runDelegation(strategy);
    assert.deepEqual(withoutBudget.limits, { maxCalls: 24, maxTokens: 128000 }, strategy);
    assert.equal(withoutBudget.root.state, 'completed', withoutBudget.root.error);
  }
});

test('budget exhaustion during integration names the budget that ran out', async () => {
  const delegation = await runDelegation('single', { delegation: { maxCalls: 2, maxTokens: 128_000 } });
  assert.equal(delegation.root.state, 'failed');
  assert.equal(delegation.root.error, 'Delegation model call budget exhausted: limit 2, used 2, reserved 0, requested 1');
  assert.equal(delegation.used.calls, 2);
  assert.equal(delegation.providerCalls, 2);

  const task = await runDelegation('single', { task: { maxCalls: 1, maxTokens: 100_000 } });
  assert.equal(task.root.state, 'failed');
  assert.equal(task.root.error, 'Task model call budget exhausted: limit 1, used 1.');
  assert.deepEqual(task.limits, { maxCalls: 24, maxTokens: 128000 });
  assert.equal(task.providerCalls, 2);
});
```

Append at the end of `test/api.test.ts` (spec E1, "no per-request override": every request schema is strict, so a budget in a body is refused with 400 `invalid_input` and nothing runs):

```ts

test('a request cannot carry a budget override', async () => {
  const store = new SqliteStore();
  let runs = 0;
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => { runs += 1; return { text: 'unused' }; },
  });
  try {
    const budgets = { maxCalls: 500, maxTokens: 20000000 };
    const refused = async (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>): Promise<void> => {
      const response = await server.app.inject({ method, url, headers, payload });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, 'invalid_input');
    };
    await refused('POST', '/v1/conversations', { title: 'Budget', budgets });
    const created = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'Budget' } });
    assert.equal(created.statusCode, 201, created.body);
    const { id, revision } = created.json().data as { id: string; revision: number };
    await refused('PATCH', `/v1/conversations/${id}`, { revision, changes: { budgets } });
    await refused('POST', `/v1/conversations/${id}/messages`, { content: 'Hello', budgets });
    await refused('POST', `/v1/conversations/${id}/messages`, { content: 'Hello', runtime: { budgets: { task: budgets } } });
    await refused('POST', `/v1/conversations/${id}/messages`, { content: 'Hello', maxCalls: 500, maxTokens: 20000000 });
    await server.tasks.drain();
    assert.equal(runs, 0);
  } finally { await server.close(); }
});
```

How the two integration scenarios count: with `delegation.maxCalls: 2` the root's delegating call is adopted into the shared ledger (1), the child makes one call (2), and the root's integration call cannot be reserved. With `task.maxCalls: 1` the root's own stored usage is already one call when its integration run starts.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='task runner applies|both delegation entry points|budget exhaustion during integration|cannot carry a budget override' test/agents-runtime.test.ts test/api.test.ts`

Expected: `ℹ tests 4`, `ℹ pass 1`, `ℹ fail 3`. The guard test `a request cannot carry a budget override` already passes and must keep passing. The other three fail (`tsx` does not typecheck, so the missing export and the seventh argument are ignored and the budgets are simply not applied):

```
✖ the task runner applies the configured task budget and keeps the runtime default without one
  + 'completed'
  - 'failed'

✖ both delegation entry points create the shared ledger with the configured delegation budget
  AssertionError [ERR_ASSERTION]: single
  +   maxCalls: 24,
  +   maxTokens: 128000
  -   maxCalls: 7,
  -   maxTokens: 90000

✖ budget exhaustion during integration names the budget that ran out
  + 'completed'
  - 'failed'
```

`npx tsc --noEmit` at this point reports `Module '"../src/runtime-adapter.js"' has no exported member 'TaskRunnerBudgets'` and `Expected 3-6 arguments, but got 7`.

- [ ] **Step 3: Write minimal implementation**

All edits are in `src/runtime-adapter.ts`.

(a) `delegateTool` signature. Existing lines:

```ts
  mode: RunMode,
  availableProfileIds: string[],
): ToolDefinition {
```

Replacement:

```ts
  mode: RunMode,
  availableProfileIds: string[],
  budget: { maxCalls: number; maxTokens: number },
): ToolDefinition {
```

(b) Inside `delegateTool`'s `execute`. Existing line:

```ts
        ...(rootDelegation ? { budget: { maxCalls: 24, maxTokens: 128_000 } } : {}),
```

Replacement:

```ts
        ...(rootDelegation ? { budget } : {}),
```

(c) `createTaskRunner` signature. Existing lines:

```ts
export function createTaskRunner(
  store: Store,
  runtime: Pick<AgentRuntime, 'run'>,
  tools: ToolDefinition[],
  artifacts?: ArtifactService,
  coordinator?: AgentCoordinator,
  visualContexts?: VisualContextStore,
): TaskRunner {
```

Replacement:

```ts
export interface TaskRunnerBudgets {
  task?: { maxCalls: number; maxTokens: number };
  delegation?: { maxCalls: number; maxTokens: number };
}

export function createTaskRunner(
  store: Store,
  runtime: Pick<AgentRuntime, 'run'>,
  tools: ToolDefinition[],
  artifacts?: ArtifactService,
  coordinator?: AgentCoordinator,
  visualContexts?: VisualContextStore,
  budgets: TaskRunnerBudgets = {},
): TaskRunner {
  const delegationBudget = {
    maxCalls: budgets.delegation?.maxCalls ?? 24,
    maxTokens: budgets.delegation?.maxTokens ?? 128_000,
  };
```

(d) The experts/MoA fan-out inside `createTaskRunner`. Existing line:

```ts
        key: 'initial', strategy, budget: { maxCalls: 24, maxTokens: 128_000 },
```

Replacement:

```ts
        key: 'initial', strategy, budget: delegationBudget,
```

(e) Where the delegate tool is built. Existing line:

```ts
      ? [delegateTool(store, coordinator, task, conversation.data.mode, availableProfileIds)]
```

Replacement:

```ts
      ? [delegateTool(store, coordinator, task, conversation.data.mode, availableProfileIds, delegationBudget)]
```

(f) The `runtime.run({...})` argument. Existing line:

```ts
      priorUsage: task.data.usage as RunUsage | undefined,
```

Replacement:

```ts
      priorUsage: task.data.usage as RunUsage | undefined,
      ...(budgets.task ? { budgets: budgets.task } : {}),
```

Do not add a budget field to any HTTP schema, conversation, task or agent profile: the spec forbids a per-request override.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/agents-runtime.test.ts test/api.test.ts && npx tsc --noEmit`

Expected: `ℹ fail 0` (14 tests when G, A, C, B1, B2 and D are applied: 9 in `test/agents-runtime.test.ts`, 5 in `test/api.test.ts`) and `tsc` prints nothing. The other callers of `createTaskRunner` (`src/bootstrap.ts` and the tests that pass three to six arguments) compile unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/runtime-adapter.ts test/agents-runtime.test.ts test/api.test.ts
git commit -m "實現：createTaskRunner 套用可設定的任務與委派預算"
```

---

### Task 8: A parent that failed because of a child carries the child's message

**Files:**
- Modify: `src/runtime-adapter.ts` (`reconcileAgentTasks`, the `const error = …` statement at line 326 as of commit 17d571f; plan D rewrites other parts of this function but leaves this statement as quoted)
- Test: `test/agents-runtime.test.ts` (the existing test `a failed child blocks aggregation and reports the actual failed child` at lines 181-196, and one new test appended at the end)

**Interfaces:**
- Consumes: `ChildResult.error?: string` returned by `AgentCoordinator.results(ownerId, planId)` (existing; it is the child task's stored `error`). The `Delegation …` messages from Task 5. The test helper `runDelegation(strategy: 'single' | 'moa', budgets?: TaskRunnerBudgets): Promise<{ root: Task; limits: { maxCalls: number; maxTokens: number }; used: { calls: number; tokens: number }; providerCalls: number }>` added to `test/agents-runtime.test.ts` in Task 7.
- Produces: the parent's error text becomes `Delegated work requires attention: <key>: <state> (<first 300 code points of the child's error>)`, with `; ` between children; a child without a stored error renders as before (`<key>: <state>`). The cut is made by code point, never by UTF-16 unit: half of a surrogate pair in `task.error` is rejected by the PostgreSQL `JSONB` column, and the parent could then never be saved. The parent's resulting state (`unknown`, `cancelled` or `failed`) and the notification type are computed exactly as before.

- [ ] **Step 1: Write the failing test**

In `test/agents-runtime.test.ts`, inside the existing test `a failed child blocks aggregation and reports the actual failed child`, existing line:

```ts
    assert.match(parent.data.error!, /worker: failed/);
```

Replacement:

```ts
    assert.equal(parent.data.error, 'Delegated work requires attention: worker: failed (Provider unavailable)');
```

Append at the end of `test/agents-runtime.test.ts`:

```ts

test('a parent that failed because a child ran out of budget carries the child\'s message', async () => {
  const exhausted = await runDelegation('single', { delegation: { maxCalls: 1, maxTokens: 128_000 } });
  assert.equal(exhausted.root.state, 'failed');
  assert.equal(
    exhausted.root.error,
    'Delegated work requires attention: worker: failed (Delegation model call budget exhausted: limit 1, used 1, reserved 0, requested 1)',
  );
  assert.equal(exhausted.providerCalls, 1);

  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const tasks = new TaskService(store, async () => { throw new Error(`${'x'.repeat(299)}\u{1F600}${'y'.repeat(100)}`); });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Long failure', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'ask', archived: false,
    });
    const root = await tasks.enqueue(principal, conversation.id, 'Delegate');
    await coordinator.prepare(principal.id, root.id, {
      key: 'initial', strategy: 'single', budget: { maxCalls: 5, maxTokens: 1000 }, children: [{ key: 'worker', prompt: 'Inspect' }],
    });
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    const parent = (await store.get<Task>('task', root.id, principal.id))!;
    assert.equal(parent.data.state, 'failed');
    assert.equal(parent.data.error, `Delegated work requires attention: worker: failed (${'x'.repeat(299)}\u{1F600})`);
  } finally { await tasks.close(); await store.close(); }
});
```

In the first scenario the root's delegating call is adopted into a shared ledger limited to one call, so the child's first model call cannot be reserved and the child fails before the provider is called a second time. In the second scenario the child's error is 299 `x`, one emoji (a surrogate pair, two UTF-16 units) and 100 `y`; the 300th code point is the emoji, so it must arrive whole. Cutting with `String.prototype.slice(0, 300)` would leave a lone high surrogate and fail this assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='failed child blocks aggregation|carries the child' test/agents-runtime.test.ts`

Expected: `ℹ tests 2`, `ℹ pass 0`, `ℹ fail 2`:

```
✖ a failed child blocks aggregation and reports the actual failed child
  + 'Delegated work requires attention: worker: failed'
  - 'Delegated work requires attention: worker: failed (Provider unavailable)'

✖ a parent that failed because a child ran out of budget carries the child's message
  + 'Delegated work requires attention: worker: failed'
  - 'Delegated work requires attention: worker: failed (Delegation model call budget exhausted: limit 1, used 1, reserved 0, requested 1)'
```

- [ ] **Step 3: Write minimal implementation**

In `src/runtime-adapter.ts`, function `reconcileAgentTasks`, existing line:

```ts
        const error = result.children.filter((child) => child.state !== 'completed').map((child) => `${child.key}: ${child.state}`).join('; ');
```

Replacement:

```ts
        const error = result.children
          .filter((child) => child.state !== 'completed')
          .map((child) => `${child.key}: ${child.state}${child.error ? ` (${Array.from(child.error).slice(0, 300).join('')})` : ''}`)
          .join('; ');
```

`Array.from` on a string iterates by code point; do not replace it with `child.error.slice(0, 300)`. Leave the `state` computation and the `store.put` / notification below it untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/agents-runtime.test.ts test/task-reconcile.test.ts && npx tsc --noEmit`

Expected: `ℹ fail 0` and `tsc` prints nothing. (`test/task-reconcile.test.ts` is created by plan B2 and matches the prefix `Delegated work requires attention`; if the file does not exist in your tree, run only `test/agents-runtime.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add src/runtime-adapter.ts test/agents-runtime.test.ts
git commit -m "修復：子任務失敗時父任務錯誤附上子任務的訊息"
```

---

### Task 9: The daily quota reservation uses `estimateTokens`

**Files:**
- Modify: `src/model-management.ts` (the runtime import at line 6 and `ModelManagement.meteredChat`, the `const reserved = …` statement at line 271, as of commit 17d571f; no earlier plan touches this file)
- Test: `test/model-management.test.ts` (the runtime import at line 10, and one new test appended at the end)

**Interfaces:**
- Consumes: `estimateTokens(text: string): number` from Task 1, imported from `./runtime/index.js`. Existing test helpers in `test/model-management.test.ts`: `setup(overrides)`, `prepare(service, actor, extra)`, `verifiedResponse(request)`, `owner`.
- Produces: no new symbol. The reservation against `dailyTokenLimit` becomes `estimateTokens(JSON.stringify(request.messages)) + estimateTokens(JSON.stringify(tool input schemas)) + (request.maxOutputTokens ?? 4096)`. The `model_quota_exceeded` (429) code and message, the `UsageDay` shape, "reserve before dispatch" and "keep the reservation when usage is unreported" do not change.

The serialized messages are kept as the thing being measured (rather than switching to the runtime's 16,384 tokens per attachment) on purpose: `estimateTokens(x)` is never larger than the byte length of `x`, so every reservation shrinks or stays equal and no deployment that works today can start failing its quota. A per-attachment constant would make a model whose daily limit is below about 20,500 tokens fail its vision probe (the existing test `concurrent calls reserve quota durably before dispatch, separately for each owner` probes vision under a 5,000-token limit and pins this).

- [ ] **Step 1: Write the failing test**

In `test/model-management.test.ts`, existing line:

```ts
import { DeviceModelProvider } from '../src/runtime/index.js';
```

Replacement:

```ts
import { DeviceModelProvider, estimateTokens } from '../src/runtime/index.js';
```

Append at the end of `test/model-management.test.ts`:

```ts

test('the daily quota reservation estimates tokens instead of counting bytes', async (t) => {
  let fail = false;
  const seen: ChatRequest[] = [];
  const { store, service } = setup({ createProvider: (provider) => ({ ...provider, chat: async (request) => {
    seen.push(request);
    if (fail) throw new Error('provider failed');
    return verifiedResponse(request);
  } }) }); t.after(() => store.close());
  await prepare(service, owner, { dailyTokenLimit: 10_000 });
  const before = (await service.usage(owner.id))[0]!;
  const runtime = await service.runtime(owner.id);
  const prompt = '海'.repeat(3000);
  assert.equal(Buffer.byteLength(prompt, 'utf8'), 9000);

  const answered = await runtime.run({ principal: owner, taskId: 'cjk-quota', mode: 'ask', prompt, modelPolicy: 'cloud', modelId: 'model' });
  assert.equal(answered.content, 'answer');
  const afterSuccess = (await service.usage(owner.id))[0]!;
  assert.equal(afterSuccess.reservedTokens, before.reservedTokens);
  assert.equal(
    afterSuccess.confirmedInputTokens + afterSuccess.confirmedOutputTokens,
    before.confirmedInputTokens + before.confirmedOutputTokens + 15,
  );

  fail = true;
  await assert.rejects(runtime.run({ principal: owner, taskId: 'cjk-quota-failed', mode: 'ask', prompt, modelPolicy: 'cloud', modelId: 'model' }));
  const request = seen.at(-1)!;
  const expected = estimateTokens(JSON.stringify(request.messages))
    + estimateTokens(JSON.stringify(request.tools.map((tool) => tool.inputSchema)))
    + request.maxOutputTokens!;
  assert.ok(expected > 3000 + 4096 && expected < 3000 + 4096 + 100, String(expected));
  assert.equal((await service.usage(owner.id))[0]!.reservedTokens, before.reservedTokens + expected);
});
```

The 3,000-character prompt is 9,000 UTF-8 bytes; with the 4,096-token output cap the old reservation exceeds the 10,000-token daily limit. `+ 15` is the usage the fixture's `reply()` reports (11 input, 4 output).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='daily quota reservation estimates' test/model-management.test.ts`

Expected: `ℹ tests 1`, `ℹ pass 0`, `ℹ fail 1`:

```
✖ the daily quota reservation estimates tokens instead of counting bytes
  Error [DomainError]: Daily model token allowance is exhausted
    code: 'model_quota_exceeded',
    statusCode: 429,
```

- [ ] **Step 3: Write minimal implementation**

In `src/model-management.ts`, existing line:

```ts
import { AgentRuntime, type ChatRequest, type ChatResponse, type ModelConfig, type ModelProvider } from './runtime/index.js';
```

Replacement:

```ts
import { AgentRuntime, estimateTokens, type ChatRequest, type ChatResponse, type ModelConfig, type ModelProvider } from './runtime/index.js';
```

In `meteredChat`, existing line:

```ts
    const reserved = Buffer.byteLength(JSON.stringify(request.messages), 'utf8') + Buffer.byteLength(JSON.stringify(request.tools.map((tool) => tool.inputSchema))) + (request.maxOutputTokens ?? 4096);
```

Replacement:

```ts
    const reserved = estimateTokens(JSON.stringify(request.messages)) + estimateTokens(JSON.stringify(request.tools.map((tool) => tool.inputSchema))) + (request.maxOutputTokens ?? 4096);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/model-management.test.ts && npx tsc --noEmit`

Expected: `ℹ tests 10`, `ℹ pass 10`, `ℹ fail 0` and `tsc` prints nothing. The existing pins (`reservedTokens >= 4096` after a failed call, `> 4096` with unreported usage, one of two concurrent calls dispatched under a 5,000-token limit) stay green without edits.

- [ ] **Step 5: Commit**

```bash
git add src/model-management.ts test/model-management.test.ts
git commit -m "修復：每日配額預留改用 estimateTokens"
```

---

### Task 10: `bootstrap` passes `config.runtime.budgets`; documentation; delivery check

**Files:**
- Modify: `src/bootstrap.ts` (`bootstrap`, the `createTaskRunner(...)` call at line 221 as of commit 17d571f; earlier plans move it a few lines down, anchor on the text)
- Modify: `README.md` (section `## Components`, directly below the bullet that starts with `- Expert and MoA tasks create durable child tasks with a shared budget`, line 60 as of commit 17d571f; plan D lengthens that bullet, so anchor on its first words)
- Test: `test/bootstrap-runtime-budgets.test.ts` (create)

**Interfaces:**
- Consumes: `Configuration['runtime']['budgets']` from Task 6; `createTaskRunner(store, runtime, tools, artifacts?, coordinator?, visualContexts?, budgets?: TaskRunnerBudgets)` from Task 7; the `Task …` message from Task 4. Existing: `bootstrap(config, options?)` resolves to an object with `store`, `tasks` (`enqueue`, `drain`), `coordinator`, `config` and `close()`.
- Produces: no new symbol. From this task on, the numbers in the configuration file are the numbers every task and every new delegation tree runs with. The outage fallback inside `bootstrap` keeps `budgets: { maxCalls: 1, maxTokens: 16_000 }`; do not touch it.

- [ ] **Step 1: Write the failing test**

Create `test/bootstrap-runtime-budgets.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import type { Conversation, Task } from '../src/domain.js';
import type { Principal } from '../src/contracts.js';

const principal: Principal = { id: 'owner', level: 1, scopes: ['*'] };

type Server = Awaited<ReturnType<typeof bootstrap>>;

async function withServer(
  runtime: unknown,
  use: (server: Server, modelRequests: () => number) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-runtime-budgets-'));
  let modelRequests = 0;
  const modelServer = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      modelRequests += 1;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify({
        message: { role: 'assistant', content: 'assistant result' },
        done: true, done_reason: 'stop',
      })}\n`);
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address === 'object');
  const tokenName = 'KIANCODE_RUNTIME_BUDGETS_TEST_TOKEN';
  const previousToken = process.env[tokenName];
  process.env[tokenName] = 'runtime-budgets-test-token-at-least-thirty-two-characters';
  let server: Server | undefined;
  try {
    server = await bootstrap(configSchema.parse({
      stateDirectory: path.join(directory, 'state'),
      checkpointDirectory: path.join(directory, 'checkpoints'),
      database: { sqlitePath: path.join(directory, 'core.sqlite') },
      auth: { developmentTokenEnv: tokenName },
      providers: [{ id: 'fake', type: 'ollama', locality: 'local', baseUrl: `http://127.0.0.1:${address.port}` }],
      models: [{ id: 'fake-model', providerId: 'fake', locality: 'local', capabilities: ['text'] }],
      attachments: { localDirectory: path.join(directory, 'attachments') },
      ...(runtime === undefined ? {} : { runtime }),
    }));
    await use(server, () => modelRequests);
  } finally {
    await server?.close();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    if (previousToken === undefined) delete process.env[tokenName];
    else process.env[tokenName] = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
}

async function runTask(server: Server, strategy: 'single' | 'moa', prompt: string): Promise<Task> {
  const conversation = await server.store.create<Conversation>('conversation', principal.id, {
    title: 'Budget', scope: 'private', modelPolicy: 'local', strategy, mode: 'ask', archived: false,
  });
  const task = await server.tasks.enqueue(principal, conversation.id, prompt);
  await server.tasks.drain();
  return (await server.store.get<Task>('task', task.id, principal.id))!.data;
}

test('bootstrap applies runtime.budgets from the configuration', async () => {
  await withServer({ budgets: { task: { maxTokens: 50 } } }, async (server, modelRequests) => {
    assert.deepEqual(server.config.runtime.budgets.task, { maxCalls: 20, maxTokens: 50 });
    const task = await runTask(server, 'single', '海'.repeat(60));
    assert.equal(task.state, 'failed');
    assert.match(task.error!, /^Task token budget exhausted: limit 50, used 0, next request needs at least \d+\.$/);
    assert.equal(modelRequests(), 0);
  });

  await withServer({ budgets: { delegation: { maxCalls: 7, maxTokens: 90000 } } }, async (server) => {
    const root = await runTask(server, 'moa', 'Compare the approaches');
    const ledger = await server.coordinator.budgets.get(principal.id, root.orchestration!.budgetId);
    assert.deepEqual(ledger.limits, { maxCalls: 7, maxTokens: 90000 });
  });
});

test('bootstrap without a runtime block keeps the built-in budgets', async () => {
  await withServer(undefined, async (server, modelRequests) => {
    assert.deepEqual(server.config.runtime.budgets, {
      task: { maxCalls: 20, maxTokens: 100000 },
      delegation: { maxCalls: 24, maxTokens: 128000 },
    });
    const single = await runTask(server, 'single', '海'.repeat(60));
    assert.equal(single.state, 'completed', single.error);
    assert.equal(single.result, 'assistant result');
    assert.equal(modelRequests(), 1);

    const root = await runTask(server, 'moa', 'Compare the approaches');
    const ledger = await server.coordinator.budgets.get(principal.id, root.orchestration!.budgetId);
    assert.deepEqual(ledger.limits, { maxCalls: 24, maxTokens: 128000 });
  });
});
```

The fake model server speaks the Ollama NDJSON protocol the same way `test/bootstrap-task-runner-hook.test.ts` does; it listens on loopback only.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/bootstrap-runtime-budgets.test.ts`

Expected: `ℹ tests 2`, `ℹ pass 1`, `ℹ fail 1`. The guard test `bootstrap without a runtime block keeps the built-in budgets` already passes; the configured budget is not applied yet:

```
✖ bootstrap applies runtime.budgets from the configuration
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'completed'
  - 'failed'
```

- [ ] **Step 3: Write minimal implementation**

In `src/bootstrap.ts`, existing line:

```ts
    const baseRunner = createTaskRunner(store, runtime, runtimeTools, artifacts, coordinator, visualContexts);
```

Replacement:

```ts
    const baseRunner = createTaskRunner(store, runtime, runtimeTools, artifacts, coordinator, visualContexts, config.runtime.budgets);
```

In `README.md`, section `## Components`, find the bullet that starts with:

```
- Expert and MoA tasks create durable child tasks with a shared budget
```

and insert this new bullet (one line) directly below it:

```
- Budgets are set by the operator in `runtime.budgets` and cannot be changed by a request. `task` (`maxCalls` 20, `maxTokens` 100000 by default) limits each task, cumulatively across pauses and resumptions. `delegation` (24 and 128000 by default) limits one delegation tree as a whole: the root task, every child and the integration run; inside a tree both budgets apply. Each value is an integer from 1 to 500 calls or 1 to 20000000 tokens. Every model call resends the conversation, so a long context is charged once per call; raise `task.maxTokens` for multi-step work on large inputs. A delegation tree keeps the limits it started with, so a changed `delegation` block applies to trees started after the restart. Before a call is sent its input is estimated at one token per four ASCII characters plus one token per other character, 16384 per image, plus the output cap; the usage a provider reports replaces the estimate, and a provider that reports none is limited by calls only. A failure names the budget that ran out, the dimension, the limit and the amount used: `Task ... budget` is `runtime.budgets.task` and `Delegation ... budget` is `runtime.budgets.delegation`. A parent that failed because of a child carries the child's message. Remove the `runtime` block before rolling back to a release that predates it, because older releases reject unknown configuration keys.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/bootstrap-runtime-budgets.test.ts`

Expected: `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`.

Then run the delivery gate: `npm run check`

Expected: `tsc --noEmit` prints nothing; the test run ends with `ℹ fail 0` (with G, A, C, B1, B2 and D applied: `ℹ tests 501`, `ℹ pass 468`, `ℹ skipped 23`, `ℹ todo 10` — the skipped and todo cases are plan G's PostgreSQL contract cases, which need `KIANCODE_TEST_DATABASE_URL`); `tsc -p tsconfig.build.json` prints nothing and the command exits 0.

Not validated locally: the PostgreSQL contract cases were skipped (no disposable database). This plan changes no store code and no stored entity shape.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.ts README.md test/bootstrap-runtime-budgets.test.ts
git commit -m "實現：bootstrap 套用 runtime.budgets 並補上預算說明文件"
```
