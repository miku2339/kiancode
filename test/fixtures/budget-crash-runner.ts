import { createHash } from 'node:crypto';
import { AgentCoordinator } from '../../src/agents/coordinator.js';
import type { BudgetLedgerRecord } from '../../src/agents/budget-ledger.js';
import type { Principal } from '../../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../../src/domain.js';
import { createTaskRunner } from '../../src/runtime-adapter.js';
import { AgentRuntime, type ModelProvider } from '../../src/runtime/index.js';
import { PostgresStore } from '../../src/storage/postgres.js';
import type { Entity, Store } from '../../src/storage/store.js';
import { TaskService } from '../../src/tasks.js';

type Checkpoint = 'task_reserve' | 'shared_reserve' | 'task_actual' | 'shared_settle' | 'recover';

interface FixtureIds {
  ownerId: string;
  conversationId: string;
  parentRequestId: string;
  planKey: string;
  childKey: string;
}

interface Probe {
  taskId: string;
  call: number;
}

interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  accountedTokens?: number;
}

interface FailureDetail {
  name: string;
  code?: string;
  message: string;
}

const databaseUrl = required('KIANCODE_FIXTURE_ISOLATION_DB');
const schema = required('KIANCODE_FIXTURE_SCHEMA');
const checkpoint = required('KIANCODE_FIXTURE_CHECKPOINT') as Checkpoint;
const clock = Number(required('KIANCODE_FIXTURE_CLOCK'));
const ids = JSON.parse(required('KIANCODE_FIXTURE_IDS')) as FixtureIds;

if (!Number.isSafeInteger(clock)) throw new Error('Invalid fixture clock');
if (!['task_reserve', 'shared_reserve', 'task_actual', 'shared_settle', 'recover'].includes(checkpoint)) {
  throw new Error('Invalid fixture checkpoint');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const parentTaskId = digest(`${ids.ownerId}\0${ids.conversationId}\0${ids.parentRequestId}`);
const planId = digest(`${ids.ownerId}\0${parentTaskId}\0${ids.planKey}`);
const childTaskId = digest(`${ids.ownerId}\0${planId}\0${ids.childKey}`);
const budgetId = digest(`${ids.ownerId}\0${parentTaskId}\0budget`);

function usageOf(value: unknown): RunUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Partial<RunUsage>;
  return typeof usage.calls === 'number'
    && typeof usage.totalTokens === 'number'
    && typeof usage.inputTokens === 'number'
    && typeof usage.outputTokens === 'number'
    ? usage as RunUsage
    : undefined;
}

function failureDetail(error: unknown): FailureDetail {
  if (!(error instanceof Error)) return { name: 'UnknownError', message: String(error) };
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name,
    ...(typeof code === 'string' ? { code } : {}),
    message: error.message,
  };
}

class CheckpointStore implements Store {
  private armed = false;
  private stopped = false;

  public constructor(private readonly inner: Store) {}

  public arm(): void {
    this.armed = checkpoint !== 'recover';
  }

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.inner.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.inner.get(kind, id, ownerId);
  }

  public scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.inner.scan(kind, ownerId);
  }

  public async put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>> {
    const saved = await this.inner.put(kind, id, ownerId, data, expectedRevision);
    if (!this.armed || this.stopped) return saved;
    if (kind === 'task' && id === childTaskId) {
      const usage = usageOf((data as Task).usage);
      if (checkpoint === 'task_reserve' && usage?.calls === 1 && usage.totalTokens === 0
        && (usage.accountedTokens ?? 0) > 0) {
        return this.stop(saved);
      }
      if (checkpoint === 'task_actual' && usage?.calls === 1 && usage.totalTokens === 25) {
        return this.stop(saved);
      }
    }
    if (kind === 'agent_budget' && id === budgetId) {
      const ledger = data as BudgetLedgerRecord;
      const reservation = ledger.reservations[`${childTaskId}:model:1`];
      if (checkpoint === 'shared_reserve' && reservation?.state === 'reserved') {
        return this.stop(saved);
      }
      if (checkpoint === 'shared_settle' && reservation?.state === 'charged') {
        return this.stop(saved);
      }
    }
    return saved;
  }

  public remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean> {
    return this.inner.remove(kind, id, ownerId, expectedRevision);
  }

  public close(): Promise<void> {
    return this.inner.close();
  }

  private async stop<T>(saved: Entity<T>): Promise<Entity<T>> {
    this.stopped = true;
    await new Promise<void>((resolve, reject) => {
      if (!process.send) {
        reject(new Error('Fixture requires an IPC channel'));
        return;
      }
      process.send({ type: 'checkpoint', checkpoint, parentTaskId, childTaskId, budgetId }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await new Promise<never>(() => undefined);
    return saved;
  }
}

async function main(): Promise<void> {
  const durable = await PostgresStore.connect(databaseUrl, { schema });
  const store = new CheckpointStore(durable);
  const principal: Principal = {
    id: ids.ownerId,
    level: 3,
    scopes: ['*'],
    expiresAt: '2100-01-01T00:00:00.000Z',
  };
  const coordinator = new AgentCoordinator(store, undefined, () => clock);
  const provider: ModelProvider = {
    id: 'controlled-budget-crash-provider',
    locality: 'local',
    async chat(request) {
      const taskId = request.context?.taskId;
      if (!taskId) throw new Error('Controlled provider requires a task id');
      const task = await store.get<Task>('task', taskId, ids.ownerId);
      const usage = usageOf(task?.data.usage);
      if (!usage) throw new Error('Controlled provider requires durable pre-dispatch usage');
      await store.create<Probe>('fixture_probe', ids.ownerId, { taskId, call: usage.calls }, `${taskId}:${usage.calls}`);
      return {
        message: { role: 'assistant', content: `controlled call ${usage.calls}` },
        usage: { inputTokens: 20, outputTokens: 5 },
      };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{
      id: 'controlled-budget-crash-model',
      providerId: provider.id,
      locality: 'local',
      capabilities: ['tools'],
    }],
    tools: [],
  });
  let runnerFailure: FailureDetail | undefined;
  let serviceFailure: FailureDetail | undefined;
  const runner = createTaskRunner(store, runtime, [], undefined, coordinator, undefined, {
    task: { maxCalls: 6, maxTokens: 64_000 },
    delegation: { maxCalls: 6, maxTokens: 64_000 },
  });
  const service = new TaskService(
    store,
    async (input) => {
      try {
        return await runner(input);
      } catch (error) {
        runnerFailure = failureDetail(error);
        throw error;
      }
    },
    {
      now: () => clock,
      leaseMs: 1_000,
      heartbeatMs: 60_000,
      reauthorize: async (current) => current,
      onError: (error) => { serviceFailure = failureDetail(error); },
    },
  );
  try {
    let parent = await store.get<Task>('task', parentTaskId, ids.ownerId);
    if (!parent) {
      await store.create<Conversation>('conversation', ids.ownerId, {
        title: 'Budget crash fixture',
        scope: 'private',
        modelPolicy: 'local',
        strategy: 'single',
        mode: 'act',
        archived: false,
      }, ids.conversationId);
      parent = await service.enqueue(principal, ids.conversationId, 'Coordinate one controlled child', ids.parentRequestId);
      const plan = await coordinator.prepare(ids.ownerId, parent.id, {
        key: ids.planKey,
        children: [{ key: ids.childKey, prompt: 'Return one controlled reply' }],
        budget: { maxCalls: 6, maxTokens: 64_000 },
      });
      if (plan.id !== planId || plan.data.childIds[0] !== childTaskId || plan.data.budgetId !== budgetId) {
        throw new Error('Fixture identifiers do not match durable orchestration identifiers');
      }
    }
    store.arm();
    await service.drain();
    const child = await store.get<Task>('task', childTaskId, ids.ownerId);
    const events = (await store.scan<TaskEvent>('event', ids.ownerId))
      .filter((event) => event.data.taskId === childTaskId);
    if (!child || child.data.state !== 'completed') {
      const ledger = await store.get<BudgetLedgerRecord>('agent_budget', budgetId, ids.ownerId);
      const probes = (await store.scan<Probe>('fixture_probe', ids.ownerId))
        .filter((probe) => probe.data.taskId === childTaskId)
        .map((probe) => probe.data.call)
        .sort((left, right) => left - right);
      const eventTrace = events.map((event) => {
        const payload = event.data.payload as {
          call?: number;
          reservedTokens?: number;
          usage?: RunUsage;
          providerTokenUsage?: { inputTokens: number; outputTokens: number };
        };
        return {
          sequence: event.data.sequence,
          type: event.data.type,
          ...(event.data.type === 'model_call' ? {
            call: payload.call,
            reservedTokens: payload.reservedTokens,
            usage: payload.usage,
          } : {}),
          ...(event.data.type === 'usage' ? {
            usage: payload.usage,
            providerTokenUsage: payload.providerTokenUsage,
          } : {}),
        };
      });
      const reservations = Object.fromEntries(Object.entries(ledger?.data.reservations ?? {})
        .filter(([id]) => id.startsWith(`${childTaskId}:model:`)));
      const phase = checkpoint === 'recover' ? 'Recovery' : `Checkpoint ${checkpoint}`;
      throw new Error(`${phase} did not complete the child: ${JSON.stringify({
        runnerFailure,
        serviceFailure,
        task: child ? {
          state: child.data.state,
          error: child.data.error,
          usage: child.data.usage,
          leaseExpiresAt: child.data.leaseExpiresAt,
        } : { state: 'missing' },
        ledger: ledger ? {
          revision: ledger.revision,
          used: ledger.data.used,
          runtimeUsage: ledger.data.runtimeUsage[childTaskId],
          reservations,
        } : { state: 'missing' },
        probes,
        events: eventTrace,
      })}`);
    }
    if (events.some((event) => event.data.type === 'tool_dispatched')) {
      throw new Error('Controlled fixture unexpectedly dispatched a tool');
    }
    await new Promise<void>((resolve, reject) => {
      if (!process.send) {
        reject(new Error('Fixture requires an IPC channel'));
        return;
      }
      process.send({ type: 'complete', parentTaskId, childTaskId, budgetId }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    await service.close();
    await store.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send) process.send({ type: 'error', message: message.replaceAll(databaseUrl, '[redacted]') });
  process.exitCode = 1;
});
