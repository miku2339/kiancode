import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Memory } from '../src/domain.js';
import { MemoryConflictService, type MemoryImportCandidate } from '../src/memory-conflicts.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const owner: Principal = { id: 'owner', level: 1, scopes: ['memory:*'] };
const at = '2026-09-30T00:00:00.000Z';

function candidate(text: string, changes: Partial<MemoryImportCandidate> = {}): MemoryImportCandidate {
  return {
    type: 'project',
    text,
    scope: 'private',
    source: 'legacy://hermes/memory#sha256=abc',
    validFrom: at,
    ...changes,
  };
}

test('held imports stay outside retrieval until an explicit review preserves provenance and replacement scope', async () => {
  const store = new SqliteStore();
  const service = new MemoryConflictService(store, () => Date.parse(at));
  try {
    const old = await store.create<Memory>('memory', owner.id, {
      ...candidate('舊海事規則', { scope: 'workspace', scopeId: 'maritime' }),
      reviewStatus: 'approved',
    }, 'old-memory');
    const incoming = candidate('新海事規則', {
      scope: 'workspace',
      scopeId: 'maritime',
      source: 'legacy://openclaw/knowledge#sha256=def',
      provenance: { sourceId: 'openclaw-knowledge', path: 'memory/rules.md', sha256: 'def' },
      replacesId: old.id,
    });
    const imported = await service.import(owner, {
      id: 'incoming-memory',
      memory: incoming,
      disposition: 'held',
      reason: '來源含待人工確認內容',
    });

    assert.equal(imported.outcome, 'held');
    assert.equal(await store.get('memory', 'incoming-memory', owner.id), undefined);
    assert.deepEqual(imported.review?.data.candidate, incoming);
    assert.deepEqual((await service.review(owner, { status: 'held' })).map((row) => row.id), [imported.review?.id]);

    const before = await store.queryMemory({
      ownerId: owner.id,
      purpose: 'relevant',
      context: { scope: 'private', conversationId: 'chat', workspaceId: 'maritime', prompt: '海事規則' },
      limit: 12,
    });
    assert.deepEqual(before.rows.map((row) => row.id), ['old-memory']);

    const resolved = await service.resolve(owner, imported.review!.id, {
      expectedRevision: imported.review!.revision,
      decision: 'approve',
    });
    assert.equal(resolved.memory?.data.reviewStatus, 'approved');
    assert.equal(resolved.memory?.data.source, incoming.source);
    assert.deepEqual(resolved.memory?.data.provenance, incoming.provenance);
    assert.equal(resolved.memory?.data.scope, incoming.scope);
    assert.equal(resolved.memory?.data.scopeId, incoming.scopeId);
    assert.equal(resolved.memory?.data.replacesId, old.id);

    const after = await store.queryMemory({
      ownerId: owner.id,
      purpose: 'relevant',
      context: { scope: 'private', conversationId: 'chat', workspaceId: 'maritime', prompt: '海事規則' },
      limit: 12,
    });
    assert.deepEqual(after.rows.map((row) => row.id), ['incoming-memory']);
  } finally {
    await store.close();
  }
});

test('direct held rows fail closed in retrieval and remain available to an explicit review-status list', async () => {
  const store = new SqliteStore();
  try {
    await store.create<Memory>('memory', owner.id, candidate('十三筆已核准舊來源'), 'approved-memory');
    await store.create<Memory>('memory', owner.id, {
      ...candidate('十三筆待審來源'),
      reviewStatus: 'held',
      reviewReason: 'possible secret requires manual review',
      replacesId: 'approved-memory',
    }, 'held-memory');
    const relevant = await store.queryMemory({
      ownerId: owner.id,
      purpose: 'relevant',
      context: { scope: 'private', conversationId: 'chat', prompt: '待審來源' },
      limit: 12,
    });
    assert.deepEqual(relevant.rows.map((row) => row.id), ['approved-memory']);
    const defaultList = await store.queryMemory({ ownerId: owner.id, purpose: 'list', limit: 10 });
    assert.deepEqual(defaultList.rows.map((row) => row.id), ['approved-memory']);
    const held = await store.queryMemory({
      ownerId: owner.id,
      purpose: 'list',
      reviewStatus: 'held',
      limit: 10,
    });
    assert.deepEqual(held.rows.map((row) => row.id), ['held-memory']);
  } finally {
    await store.close();
  }
});

test('ID conflicts require an explicit alternate ID and never overwrite the existing source', async () => {
  const store = new SqliteStore();
  const service = new MemoryConflictService(store, () => Date.parse(at));
  try {
    const existing = await store.create<Memory>('memory', owner.id, candidate('現有內容', { source: 'message:existing' }), 'shared-id');
    const incoming = candidate('匯入內容', { source: 'legacy://held/source#sha256=123' });
    const imported = await service.import(owner, { id: existing.id, memory: incoming, disposition: 'approved' });
    assert.equal(imported.outcome, 'conflict');
    assert.equal(imported.review?.data.cause, 'id_conflict');
    await assert.rejects(service.resolve(owner, imported.review!.id, {
      expectedRevision: imported.review!.revision,
      decision: 'approve',
    }), (error: unknown) => error instanceof DomainError && error.code === 'memory_id_conflict');

    const resolved = await service.resolve(owner, imported.review!.id, {
      expectedRevision: imported.review!.revision,
      decision: 'approve',
      memoryId: 'shared-id-imported',
    });
    assert.equal(resolved.memory?.id, 'shared-id-imported');
    assert.equal(resolved.memory?.data.source, incoming.source);
    assert.equal((await store.get<Memory>('memory', existing.id, owner.id))?.data.source, 'message:existing');
  } finally {
    await store.close();
  }
});

test('replacement scope conflicts cannot be approved or alter either source', async () => {
  const store = new SqliteStore();
  const service = new MemoryConflictService(store, () => Date.parse(at));
  try {
    const target = await store.create<Memory>('memory', owner.id, candidate('私人來源', { source: 'message:private' }), 'private-target');
    const incoming = candidate('工作區來源', {
      scope: 'workspace',
      scopeId: 'workspace-a',
      source: 'legacy://workspace/source#sha256=456',
      replacesId: target.id,
    });
    const imported = await service.import(owner, { id: 'workspace-memory', memory: incoming, disposition: 'approved' });
    assert.equal(imported.review?.data.cause, 'replacement_scope_mismatch');
    await assert.rejects(service.resolve(owner, imported.review!.id, {
      expectedRevision: imported.review!.revision,
      decision: 'approve',
    }), (error: unknown) => error instanceof DomainError && error.code === 'invalid_replacement');
    assert.equal(await store.get('memory', 'workspace-memory', owner.id), undefined);
    assert.equal((await store.get<Memory>('memory', target.id, owner.id))?.data.source, 'message:private');
  } finally {
    await store.close();
  }
});
