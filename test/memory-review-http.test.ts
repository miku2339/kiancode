import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/http/server.js';
import { developmentAuth } from '../src/auth.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const token = 'test-owner-token-with-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('source imports remain outside ordinary retrieval until reviewed and preserve provenance across retries', async () => {
  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  const entry = {
    id: 'source-episode-1',
    memory: { type: 'episode', text: 'A source memory', scope: 'private', source: 'archive/message-1', validFrom: '2026-01-01T00:00:00.000Z', provenance: { messageId: 'message-1', sourceSystem: 'legacy' } },
  };
  try {
    const imported = await server.app.inject({ method: 'POST', url: '/v1/memories/import', headers, payload: { entries: [entry] } });
    assert.equal(imported.statusCode, 200, imported.body);
    const held = imported.json().data[0]; assert.equal(held.outcome, 'held');
    const retry = await server.app.inject({ method: 'POST', url: '/v1/memories/import', headers, payload: { entries: [entry] } });
    assert.equal(retry.json().data[0].review.id, held.review.id);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/memories?q=source', headers })).json().data.length, 0);
    const reviewed = await server.app.inject({ method: 'POST', url: `/v1/memories/reviews/${held.review.id}/resolve`, headers, payload: { expectedRevision: held.review.revision, decision: 'approve' } });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const visible = (await server.app.inject({ method: 'GET', url: '/v1/memories?q=source', headers })).json().data;
    assert.equal(visible.length, 1); assert.deepEqual(visible[0].data.provenance, entry.memory.provenance);
    const stale = await server.app.inject({ method: 'POST', url: `/v1/memories/reviews/${held.review.id}/resolve`, headers, payload: { expectedRevision: held.review.revision, decision: 'reject' } });
    assert.equal(stale.statusCode, 409);
  } finally { await server.close(); }
});
