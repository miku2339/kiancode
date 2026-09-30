import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactService, extractDocument } from '../src/artifacts.js';
import { LocalBlobStore } from '../src/storage/blobs.js';
import { SqliteStore } from '../src/storage/sqlite.js';

test('attachments retain checksum and sources and reject another account', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-artifact-')); const store = new SqliteStore();
  try {
    const service = new ArtifactService(store, new LocalBlobStore(directory));
    const uploaded = await service.upload('alice', 'guide.md', 'text/markdown', Buffer.from('Project instructions'));
    assert.equal(uploaded.data.pages?.[0]?.text, 'Project instructions');
    assert.equal(Buffer.from((await service.read('alice', uploaded.id)).bytes).toString(), 'Project instructions');
    await assert.rejects(service.read('bob', uploaded.id), /not found/);
    await service.remove('alice', uploaded.id); await assert.rejects(service.read('alice', uploaded.id), /not found/);
    await assert.rejects(extractDocument(Buffer.from('not a PDF'), 'application/pdf'), /Invalid PDF/);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('PDF extraction returns real page text with page provenance', async () => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const content = 'BT /F1 12 Tf 30 100 Td (Kian reference document) Tj ET';
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pages = await extractDocument(Buffer.from(pdf), 'application/pdf');
  assert.equal(pages[0]?.page, 1); assert.match(pages[0]?.text ?? '', /Kian reference document/);
});

test('concurrent attachment writes cannot overwrite an acknowledged identifier', async () => {
  const { LocalBlobStore } = await import('../src/storage/blobs.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-blobs-race-'));
  try {
    const blobs = new LocalBlobStore(directory);
    const writes = await Promise.allSettled([blobs.put('concurrent-artifact-id', Buffer.from('first')), blobs.put('concurrent-artifact-id', Buffer.from('second'))]);
    assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
    const content = Buffer.from(await blobs.get('concurrent-artifact-id')).toString();
    assert.ok(['first', 'second'].includes(content));
    await assert.rejects(blobs.put('concurrent-artifact-id', Buffer.from('replacement')), { code: 'conflict' });
    assert.equal(Buffer.from(await blobs.get('concurrent-artifact-id')).toString(), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('artifact upload retries reuse one owner-scoped ID and cannot replace deleted content', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-artifact-retry-'));
  const store = new SqliteStore();
  try {
    const service = new ArtifactService(store, new LocalBlobStore(directory));
    const bytes = Buffer.from('Canonical attachment');
    const [first, second] = await Promise.all([service.upload('alice', 'note.txt', 'text/plain', bytes, 'message-1'), service.upload('alice', 'note.txt', 'text/plain', bytes, 'message-1')]);
    assert.equal(first.id, second.id);
    assert.equal((await store.scan('artifact', 'alice')).length, 1);
    await assert.rejects(service.upload('alice', 'note.txt', 'text/plain', Buffer.from('Different'), 'message-1'), { code: 'idempotency_conflict' });
    const other = await service.upload('bob', 'note.txt', 'text/plain', bytes, 'message-1');
    assert.notEqual(other.id, first.id);
    await service.remove('alice', first.id);
    await assert.rejects(service.upload('alice', 'note.txt', 'text/plain', bytes, 'message-1'), { code: 'idempotency_conflict' });
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('tool artifact idempotency binds the producing task', async () => {
  const store = new SqliteStore();
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-tool-artifact-'));
  const service = new ArtifactService(store, new LocalBlobStore(root));
  const bytes = Buffer.from('task result');
  try {
    const first = await service.upload('alice', 'result.txt', 'text/plain', bytes, 'tool-result-1', 'tool', 'task-1');
    const retry = await service.upload('alice', 'result.txt', 'text/plain', bytes, 'tool-result-1', 'tool', 'task-1');
    assert.equal(retry.id, first.id);
    await assert.rejects(
      service.upload('alice', 'result.txt', 'text/plain', bytes, 'tool-result-1', 'tool', 'task-2'),
      { code: 'idempotency_conflict' },
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
