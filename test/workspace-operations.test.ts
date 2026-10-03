import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { DomainError, notDispatched, type ToolDefinition } from '../src/contracts.js';
import type { Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const token = 'workspace-operations-development-token-thirty-two';
const headers = { authorization: `Bearer ${token}` };

interface EventPayload {
  type?: string;
  toolCallId?: string;
  toolOccurrenceId?: string;
  outcome?: string;
  isError?: boolean;
  notDispatched?: boolean;
  sideEffect?: string;
}

function fakeTool(sideEffect: 'write' | 'external', execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: sideEffect === 'write' ? 'fake.write' : 'fake.run',
    description: 'Fake workspace tool',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    requiresWorkspace: true,
    sideEffect,
    execute,
  };
}

async function harness(tool: ToolDefinition) {
  const store = new SqliteStore();
  const server = await createServer({
    store,
    tools: [tool],
    authenticate: developmentAuth(token),
    runner: createTaskRunner(store, { run: async () => { throw new Error('model must not run'); } }, [tool]),
    reauthorize: async (current) => current,
  });
  const workspace = await store.create('workspace', 'local-owner', {
    name: 'Local', root: '/project', deviceId: 'server', capabilities: [], allowCloud: false,
  });
  return {
    store,
    server,
    async operate(requestId: string): Promise<string> {
      const response = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/operations`,
        headers,
        payload: { tool: tool.name, input: { path: 'a.txt' }, requestId },
      });
      assert.equal(response.statusCode, 202, response.body);
      await server.tasks.drain();
      return response.json().data.id as string;
    },
    async task(id: string): Promise<Task> {
      return (await store.get<Task>('task', id, 'local-owner'))!.data;
    },
    async payloads(id: string): Promise<EventPayload[]> {
      return (await server.tasks.events('local-owner', id)).map((row) => row.data.payload as EventPayload);
    },
    async close(): Promise<void> { await server.close(); await store.close(); },
  };
}

for (const [sideEffect, error] of [
  ['write', notDispatched('write_conflict', 'File changed since it was read', 409)],
  ['external', notDispatched('terminal_sandbox_required', 'Terminal was refused before launch', 503)],
] as const) {
  test(`a workspace ${sideEffect} refusal ends failed and closes its occurrence`, async () => {
    const context = await harness(fakeTool(sideEffect, async () => { throw error; }));
    try {
      const id = await context.operate('refused-1');
      const task = await context.task(id);
      assert.equal(task.state, 'failed');
      assert.equal(task.error, error.message);
      const events = (await context.payloads(id)).filter((payload) => payload.type?.startsWith('tool_'));
      assert.deepEqual(events.map((payload) => payload.type), ['tool_dispatched', 'tool_result']);
      assert.deepEqual(
        [events[1]!.outcome, events[1]!.isError, events[1]!.notDispatched, events[1]!.sideEffect],
        ['failed', true, true, sideEffect],
      );
      assert.ok(events[0]!.toolOccurrenceId);
      assert.equal(events[1]!.toolOccurrenceId, events[0]!.toolOccurrenceId);
    } finally { await context.close(); }
  });
}

for (const sideEffect of ['write', 'external'] as const) {
  test(`an unmarked ${sideEffect} workspace failure remains unknown and is not replayed`, async () => {
    let executions = 0;
    const context = await harness(fakeTool(sideEffect, async () => {
      executions += 1;
      throw new DomainError('invalid_input', 'Remote side rejected the request');
    }));
    try {
      const id = await context.operate('unknown-1');
      assert.equal((await context.task(id)).state, 'unknown');
      assert.equal(await context.operate('unknown-1'), id);
      assert.equal(executions, 1);
      const events = (await context.payloads(id)).filter((payload) => payload.type?.startsWith('tool_'));
      assert.deepEqual(events.map((payload) => payload.type), ['tool_dispatched', 'tool_result']);
      assert.deepEqual([events[1]!.outcome, events[1]!.toolOccurrenceId], [
        'unknown', events[0]!.toolOccurrenceId,
      ]);
    } finally { await context.close(); }
  });
}
