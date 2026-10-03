import assert from 'node:assert/strict';
import test from 'node:test';
import { requireScope } from '../src/auth.js';
import { asNotDispatched, DomainError, isNotDispatched, notDispatched, type Principal } from '../src/contracts.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';

test('a DomainError is not marked unless the throw site says so', () => {
  const plain = new DomainError('invalid_input', 'bad');
  assert.equal(plain.notDispatched, false);
  assert.equal(plain.name, 'DomainError');
  assert.equal(plain.statusCode, 400);
  assert.equal(new DomainError('conflict', 'busy', 409).notDispatched, false);
  assert.equal(new DomainError('conflict', 'busy', 409, {}).notDispatched, false);
  assert.equal(isNotDispatched(plain), false);
});

test('notDispatched builds a marked DomainError with the given code, message and status', () => {
  const error = notDispatched('forbidden', 'Missing capability: shell:execute', 403);
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, 'forbidden');
  assert.equal(error.message, 'Missing capability: shell:execute');
  assert.equal(error.statusCode, 403);
  assert.equal(error.notDispatched, true);
  assert.equal(notDispatched('invalid_input', 'bad').statusCode, 400);
  assert.equal(isNotDispatched(error), true);
});

test('asNotDispatched marks a DomainError without changing its code, message or status', () => {
  const original = new DomainError('write_conflict', 'File changed', 409);
  const marked = asNotDispatched(original, 'fallback_code', 503);
  assert.notEqual(marked, original);
  assert.equal(original.notDispatched, false);
  assert.deepEqual(
    [marked.code, marked.message, marked.statusCode, marked.notDispatched],
    ['write_conflict', 'File changed', 409, true],
  );
  assert.equal(asNotDispatched(marked, 'fallback_code', 503), marked);
});

test('asNotDispatched converts any other thrown value using the fallback code and status', () => {
  const fromError = asNotDispatched(new Error('ENOENT: no such file'), 'workspace_unavailable', 404);
  assert.deepEqual(
    [fromError.code, fromError.message, fromError.statusCode, fromError.notDispatched],
    ['workspace_unavailable', 'ENOENT: no such file', 404, true],
  );
  const fromAbort = asNotDispatched(new DOMException('The operation was aborted.', 'AbortError'), 'aborted', 499);
  assert.deepEqual([fromAbort.code, fromAbort.message, fromAbort.statusCode], ['aborted', 'The operation was aborted.', 499]);
  const fromString = asNotDispatched('plain text', 'tool_failed');
  assert.deepEqual(
    [fromString.code, fromString.message, fromString.statusCode, fromString.notDispatched],
    ['tool_failed', 'plain text', 400, true],
  );
});

test('isNotDispatched accepts only a marked DomainError', () => {
  assert.equal(isNotDispatched(new Error('boom')), false);
  assert.equal(isNotDispatched(undefined), false);
  assert.equal(isNotDispatched(null), false);
  assert.equal(isNotDispatched({ code: 'invalid_input', message: 'bad', statusCode: 400, notDispatched: true }), false);
  assert.equal(isNotDispatched(new DomainError('invalid_input', 'bad', 400, { notDispatched: true })), true);
});

test('requireScope throws a marked forbidden and the HTTP error body does not expose the marker', async () => {
  const limited: Principal = { id: 'limited', level: 2, scopes: ['chat:read', 'kiancode:task:read', 'workspace:*'] };
  for (const scope of ['chat:read', 'task:read', 'workspace:write']) {
    assert.equal(requireScope(limited, scope), undefined);
  }
  assert.throws(() => requireScope(limited, 'shell:execute'), (error: unknown) => isNotDispatched(error)
    && error.code === 'forbidden' && error.statusCode === 403 && error.message === 'Missing capability: shell:execute');

  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: async () => limited, runner: async () => ({ text: 'unused' }) });
  try {
    const response = await server.app.inject({ method: 'GET', url: '/v1/memories' });
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(response.json(), { error: { code: 'forbidden', message: 'Missing capability: memory:read' } });
  } finally { await server.close(); await store.close(); }
});
