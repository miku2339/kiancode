import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import { DomainError, type Principal, type ToolDefinition, type Workspace } from '../src/contracts.js';
import type { Conversation, Message, Task, TaskEvent } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, type ChatMessage, type ModelProvider } from '../src/runtime/index.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';

for (const backend of ['SQLite', 'PostgreSQL'] as const) {
  test(`${backend}: parent verification survives restart and rejects a pre-child read (controlled model/tools)`, {
    skip: backend === 'PostgreSQL' && !databaseUrl ? 'KIANCODE_TEST_DATABASE_URL is not set' : false,
  }, async () => {
    const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
    const admin = backend === 'PostgreSQL'
      ? new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
      : undefined;
    let schemaCreated = false;
    let directory: string | undefined;
    let store: Store | undefined;
    let service: TaskService | undefined;
    let coordinator: AgentCoordinator | undefined;
    let readAfterChild = false;
    let writes = 0;
    let reads = 0;
    const owner: Principal = {
      id: 'verification-owner', level: 3, scopes: ['*'],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const clock = Date.now();
    const effectId = 'verification-resource';
    const workspaceId = 'verification-workspace';
    const filePath = 'result.txt';
    const provider: ModelProvider = {
      id: 'controlled-verification-provider', locality: 'local',
      async chat(request) {
        const integrating = request.messages.some((message) => message.role === 'user'
          && message.content.startsWith('Integrate these delegated results'));
        const previousTool = request.messages.at(-1)?.role === 'tool';
        let message: ChatMessage;
        if (integrating) {
          message = readAfterChild && !previousTool
            ? { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'workspace.read', arguments: { path: filePath } }] }
            : { role: 'assistant', content: 'Verified delegated work.' };
        } else {
          message = previousTool
            ? { role: 'assistant', content: 'Child wrote the result.' }
            : { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'workspace.write', arguments: { path: filePath, content: 'new child content' } }] };
        }
        return { message, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const open = async (): Promise<void> => {
      await service?.close();
      await store?.close();
      store = backend === 'PostgreSQL'
        ? await PostgresStore.connect(databaseUrl, { schema })
        : new SqliteStore(join(directory!, 'state.sqlite'));
      coordinator = new AgentCoordinator(store, undefined, () => clock);
      const tools: ToolDefinition[] = [
        {
          name: 'workspace.write', description: 'Write the controlled test resource',
          inputSchema: { type: 'object' }, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'write',
          async execute(input) {
            const previous = await store!.get<{ text: string }>('effect', effectId, owner.id);
            assert.ok(previous);
            writes += 1;
            const text = String(input.content);
            await store!.put('effect', effectId, owner.id, { text }, previous.revision);
            return { content: JSON.stringify({ path: filePath, sha256: createHash('sha256').update(text).digest('hex') }) };
          },
        },
        {
          name: 'workspace.read', description: 'Read back the controlled test resource',
          inputSchema: { type: 'object' }, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'read',
          async execute(input) {
            if (input.path !== filePath) throw new DomainError('path_not_found', 'Controlled resource not found', 404);
            reads += 1;
            const row = await store!.get<{ text: string }>('effect', effectId, owner.id);
            assert.ok(row);
            return { content: JSON.stringify({ path: filePath, content: row.data.text,
              sha256: createHash('sha256').update(row.data.text).digest('hex') }) };
          },
        },
      ];
      const runtime = new AgentRuntime({
        providers: [provider],
        models: [{ id: 'controlled-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
        tools,
      });
      service = new TaskService(store, createTaskRunner(store, runtime, tools, undefined, coordinator), {
        reauthorize: async (current) => current,
        now: () => clock,
        leaseMs: 300_000,
        heartbeatMs: 100_000,
      });
    };

    try {
      if (admin) {
        await admin.query(`CREATE SCHEMA ${schema}`);
        schemaCreated = true;
      } else {
        directory = await mkdtemp(join(tmpdir(), 'kiancode-verification-'));
      }
      await open();
      await store!.create('effect', owner.id, { text: 'old content' }, effectId);
      await store!.create<Workspace>('workspace', owner.id, {
        id: workspaceId, ownerId: owner.id, name: 'Verification', root: '/project', deviceId: 'server',
        capabilities: [], allowCloud: false,
      }, workspaceId);
      const conversation = await store!.create<Conversation>('conversation', owner.id, {
        title: 'Verification', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act',
        archived: false, workspaceId,
      });

      for (const freshRead of [false, true]) {
        readAfterChild = freshRead;
        const parent = await service!.enqueue(owner, conversation.id, 'Coordinate verified work');
        // This real historical receipt shares the child's clock millisecond, but precedes its change.
        for (const [offset, event] of [
          { type: 'tool_dispatched', toolCall: { id: 'old-read', name: 'workspace.read', arguments: { path: filePath } },
            actionHash: 'historical-read', sideEffect: 'read' },
          { type: 'tool_result', toolCallId: 'old-read', actionHash: 'historical-read', sideEffect: 'read',
            outcome: 'confirmed', isError: false, result: { content: JSON.stringify({ path: filePath, content: 'old content',
              sha256: createHash('sha256').update('old content').digest('hex') }) } },
        ].entries()) {
          await store!.create<TaskEvent>('event', owner.id, {
            taskId: parent.id, sequence: 2 + offset, type: event.type, payload: event, at: new Date(clock).toISOString(),
          }, `${parent.id}:historical:${offset}`);
        }
        const plan = await coordinator!.prepare(owner.id, parent.id, {
          key: 'verified-child', children: [{ key: 'worker', prompt: 'Write the result' }],
          budget: { maxCalls: 8, maxTokens: 80_000 },
        });
        const childId = plan.data.childIds[0]!;
        await service!.drain();
        let child = (await store!.get<Task>('task', childId, owner.id))!;
        assert.equal(child.data.state, 'waiting_for_approval', child.data.error ?? 'Child must require its own write approval');
        assert.equal(writes, freshRead ? 1 : 0);
        await service!.control(owner.id, childId, 'resume', [child.data.pendingActions[0]!.hash], owner);
        await service!.drain();
        child = (await store!.get<Task>('task', childId, owner.id))!;
        assert.equal(child.data.state, 'completed', child.data.error ?? 'Approved child must complete');
        const childReceipt = (await service!.events(owner.id, childId))
          .find((event) => event.data.type === 'tool_result');
        assert.equal(childReceipt?.data.at, new Date(clock).toISOString());
        await coordinator!.queueIntegration(owner.id, plan.id);
        const boundary = (await store!.get<OrchestrationPlan>('agent_plan', plan.id, owner.id))!.data.integrationBoundary;
        assert.ok(boundary);
        assert.ok(boundary.parentEventSequence >= 3);

        await open();
        assert.deepEqual((await store!.get<OrchestrationPlan>('agent_plan', plan.id, owner.id))!.data.integrationBoundary, boundary);
        await service!.drain();
        const result = (await store!.get<Task>('task', parent.id, owner.id))!;
        assert.equal(result.data.state, freshRead ? 'completed' : 'failed', result.data.error ?? 'Parent must pass the causal verification gate');
        assert.equal(result.data.orchestration?.verification, freshRead ? 'passed' : 'failed');
        const events = (await service!.events(owner.id, parent.id)).map((event) => event.data.type);
        const assistant = (await store!.scan<Message>('message', owner.id))
          .filter((message) => message.data.taskId === parent.id && message.data.role === 'assistant');
        assert.equal(events.includes('final'), freshRead);
        assert.equal(events.includes('completed'), freshRead);
        assert.equal(assistant.length, freshRead ? 1 : 0);
        assert.equal(writes, freshRead ? 2 : 1);
        assert.equal(reads, freshRead ? 1 : 0);

        await open();
        const durable = (await store!.get<Task>('task', parent.id, owner.id))!;
        assert.equal(durable.data.state, result.data.state);
        assert.equal(durable.data.orchestration?.verification, result.data.orchestration?.verification);
        assert.equal(writes, freshRead ? 2 : 1);
      }
    } finally {
      await service?.close();
      await store?.close();
      try {
        if (schemaCreated) await admin!.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin?.end();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  });
}
