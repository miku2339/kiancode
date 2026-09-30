import assert from 'node:assert/strict';
import test from 'node:test';
import { relevantMemory } from '../src/runtime-adapter.js';
import type { Memory } from '../src/domain.js';
import type { Entity } from '../src/storage/store.js';

const at = '2026-09-27T00:00:00.000Z';
function memory(id: string, text: string, changes: Partial<Memory> = {}): Entity<Memory> {
  return { id, ownerId: 'owner', revision: 1, createdAt: at, updatedAt: at,
    data: { type: 'document', scope: 'private', text, source: `document:${id}`, validFrom: at, ...changes } };
}

test('Cantonese questions retrieve Chinese knowledge while respecting scope and replacement', () => {
  const rows = [
    memory('maritime', '海事專案引用香港法例的官方文件。'),
    memory('unrelated', '今天午餐吃番茄炒蛋。'),
    memory('old', '海事專案以前使用舊版法例。'),
    memory('replacement', '海事專案使用更新後的法例。', { replacesId: 'old' }),
    memory('other-agent', '海事專案私有來源。', { scope: 'agent', scopeId: 'another-agent' }),
    memory('expired', '海事專案過期來源。', { validTo: at }),
  ];
  const result = relevantMemory(rows, { scope: 'private', conversationId: 'chat', prompt: '可以講返海事專案嘅法例資料來源嗎？' }, Date.parse(at) + 1000);
  assert.deepEqual(new Set(result.map((row) => row.id)), new Set(['maritime', 'replacement']));
  assert.deepEqual(relevantMemory(rows, { scope: 'group', conversationId: 'group', prompt: '海事專案法例' }, Date.parse(at) + 1000), []);
});

test('English retrieval remains case insensitive and persona remains available', () => {
  const rows = [memory('persona', 'Speak Traditional Chinese.', { type: 'persona' }), memory('project', 'The parser uses PostgreSQL transactions.'), memory('unrelated', 'Apple pie recipe.')];
  assert.deepEqual(relevantMemory(rows, { scope: 'private', conversationId: 'chat', prompt: 'Explain POSTGRESQL durability.' }, Date.parse(at)).map((row) => row.id), ['persona', 'project']);
});
