import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const token = 'management-owner-token-with-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('agent profiles retain an allowlisted model and schedules can be deleted by revision', async () => {
  const store = new SqliteStore();
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
    models: [{ id: 'configured-model', locality: 'cloud', capabilities: ['tools'] }],
    automations: { eventTriggersEnabled: false, schedulerEnabled: true },
  });
  try {
    const agent = await server.app.inject({
      method: 'POST', url: '/v1/agents', headers,
      payload: { name: 'Reviewer', systemPrompt: 'Review carefully.', strategy: 'experts', modelPolicy: 'cloud', modelId: 'configured-model' },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    assert.equal(agent.json().data.data.modelId, 'configured-model');

    const invalid = await server.app.inject({
      method: 'POST', url: '/v1/agents', headers,
      payload: { name: 'Invalid', systemPrompt: 'Fail.', modelId: 'missing-model' },
    });
    assert.equal(invalid.statusCode, 404, invalid.body);

    const conversation = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'Scheduled' } });
    const schedule = await server.app.inject({
      method: 'POST', url: '/v1/schedules', headers,
      payload: {
        name: 'Run check',
        prompt: 'Run check',
        nextAt: new Date(Date.now() + 60_000).toISOString(),
        enabled: true,
        settings: {
          conversationId: conversation.json().data.id,
          permissions: ['model:read'],
          notification: { type: 'none' },
        },
      },
    });
    assert.equal(schedule.statusCode, 201, schedule.body);
    const removed = await server.app.inject({
      method: 'DELETE', url: `/v1/schedules/${schedule.json().data.id}?revision=${schedule.json().data.revision}`, headers,
    });
    assert.equal(removed.statusCode, 204, removed.body);
    const list = await server.app.inject({ method: 'GET', url: '/v1/schedules', headers });
    assert.deepEqual(list.json().data, []);
  } finally {
    await server.close();
  }
});
