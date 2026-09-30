import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { requireScope } from './auth.js';
import { DomainError, type Principal } from './contracts.js';
import type { Store } from './storage/store.js';
import { type BlobStore, sha256 } from './storage/blobs.js';

export interface Artifact { name: string; mimeType: string; bytes: number; sha256: string; storageId: string; source: 'upload' | 'tool'; producerTaskId?: string; pages?: Array<{ page: number; text: string }>; extractionError?: string }

function validateDocx(bytes: Uint8Array): void {
  const data = Buffer.from(bytes); let total = 0; let entries = 0;
  for (let offset = 0; offset + 46 <= data.length; offset += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) continue;
    const size = data.readUInt32LE(offset + 24); total += size; entries += 1;
    if (size === 0xffffffff || total > 64 * 1024 * 1024 || entries > 2000) throw new DomainError('document_too_large', 'Document archive exceeds extraction limits', 413);
    offset += 45 + data.readUInt16LE(offset + 28) + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
  }
  if (!entries) throw new DomainError('invalid_document', 'Invalid Word archive');
}

export async function extractDocument(bytes: Uint8Array, mimeType: string): Promise<Array<{ page: number; text: string }>> {
  if (mimeType.startsWith('text/') || ['application/json', 'application/xml'].includes(mimeType)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.length > 1000000) throw new DomainError('document_too_large', 'Document text exceeds 1,000,000 characters', 413);
    return [{ page: 1, text }];
  }
  if (mimeType !== 'application/pdf' && mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return [];
  if (mimeType === 'application/pdf' && !Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) throw new DomainError('invalid_document', 'Invalid PDF header');
  if (mimeType.endsWith('document')) validateDocx(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './document-worker.ts' : './document-worker.js', import.meta.url), { workerData: { bytes, mimeType }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new DomainError('extraction_timeout', 'Document extraction exceeded its time limit')); }, 15000);
    worker.once('message', (result: { pages?: Array<{ page: number; text: string }>; error?: string }) => {
      clearTimeout(timer); void worker.terminate();
      if (result.error) reject(new DomainError('extraction_failed', result.error)); else resolve(result.pages ?? []);
    });
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
    worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new DomainError('extraction_failed', 'Document worker stopped before completion')); });
  });
}

export class ArtifactService {
  constructor(private store: Store, private blobs: BlobStore) {}
  async upload(ownerId: string, name: string, mimeType: string, bytes: Uint8Array, requestId?: string, source: Artifact['source'] = 'upload', producerTaskId?: string) {
    if (bytes.byteLength > 32 * 1024 * 1024) throw new DomainError('attachment_too_large', 'Attachment exceeds 32 MB', 413);
    if (requestId !== undefined && (!requestId || requestId.length > 200)) throw new DomainError('invalid_request_id', 'Attachment request ID must contain 1 to 200 characters');
    if ((source === 'tool') !== Boolean(producerTaskId)) throw new DomainError('invalid_artifact_producer', 'Tool artifacts require their producing task');
    const storageId = requestId ? sha256(Buffer.from(`${ownerId}\0artifact\0${requestId}`)) : randomUUID();
    const fingerprint = sha256(Buffer.from(JSON.stringify({ name, mimeType, hash: sha256(bytes), source, producerTaskId })));
    if (requestId) {
      let request = await this.store.get<{ fingerprint: string; deleted?: boolean }>('artifact_request', storageId, ownerId);
      if (!request) {
        try { request = await this.store.create('artifact_request', ownerId, { fingerprint }, storageId); }
        catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; request = await this.store.get('artifact_request', storageId, ownerId); }
      }
      if (request?.data.fingerprint !== fingerprint || request.data.deleted) throw new DomainError('idempotency_conflict', 'Attachment request ID belongs to different or deleted content', 409);
      const existing = await this.store.get<Artifact>('artifact', storageId, ownerId);
      if (existing) return existing;
    }
    const digest = await this.blobs.put(storageId, bytes);
    let pages: Artifact['pages']; let extractionError: string | undefined;
    try { pages = await extractDocument(bytes, mimeType); }
    catch (error) { extractionError = error instanceof Error ? error.message : 'Text extraction failed'; }
    try { return await this.store.create<Artifact>('artifact', ownerId, { name, mimeType, bytes: bytes.length, sha256: digest, storageId, source, ...(producerTaskId ? { producerTaskId } : {}), pages, extractionError }, storageId); }
    catch (error) {
      if (!requestId || !(error instanceof DomainError && error.code === 'conflict')) throw error;
      const existing = await this.store.get<Artifact>('artifact', storageId, ownerId);
      if (!existing || existing.data.sha256 !== digest) throw error;
      return existing;
    }
  }
  async read(ownerId: string, id: string) {
    const row = await this.store.get<Artifact>('artifact', id, ownerId);
    if (!row) throw new DomainError('not_found', 'Attachment not found', 404);
    const bytes = await this.blobs.get(row.data.storageId);
    if (sha256(bytes) !== row.data.sha256) throw new DomainError('storage_integrity', 'Attachment checksum does not match', 503);
    return { row, bytes };
  }
  async remove(ownerId: string, id: string) {
    const row = await this.store.get<Artifact>('artifact', id, ownerId);
    if (!row) throw new DomainError('not_found', 'Attachment not found', 404);
    const request = await this.store.get<{ fingerprint: string; deleted?: boolean }>('artifact_request', id, ownerId);
    if (request && !request.data.deleted) await this.store.put('artifact_request', id, ownerId, { ...request.data, deleted: true }, request.revision);
    await this.blobs.remove(row.data.storageId); await this.store.remove('artifact', id, ownerId, row.revision);
  }
}

export async function registerArtifactRoutes(app: FastifyInstance, service: ArtifactService, store: Store, principal: (request: FastifyRequest) => Principal) {
  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024, files: 1, fields: 5, parts: 6 } });
  const params = (request: FastifyRequest) => z.object({ id: z.string().min(1).max(200) }).parse(request.params);
  app.get('/v1/artifacts', async (request) => {
    const owner = principal(request); requireScope(owner, 'artifact:read');
    return { data: (await store.scan<Artifact>('artifact', owner.id)).map((row) => ({ ...row, data: { ...row.data, pages: undefined, storageId: undefined } })) };
  });
  app.post('/v1/artifacts', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'artifact:write');
    const upload = await request.file(); if (!upload) throw new DomainError('file_required', 'Choose a file to upload');
    const requestId = request.headers['idempotency-key'];
    if (Array.isArray(requestId)) throw new DomainError('invalid_request_id', 'Provide one idempotency key');
    const data = await service.upload(owner.id, upload.filename.slice(0, 255).replace(/[\r\n\0/\\]/g, '_'), upload.mimetype, await upload.toBuffer(), requestId);
    return reply.code(201).send({ data: { ...data, data: { ...data.data, pages: undefined, storageId: undefined } } });
  });
  app.get('/v1/artifacts/:id', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'artifact:read');
    const { row, bytes } = await service.read(owner.id, params(request).id);
    reply.header('content-type', row.data.mimeType);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.data.name)}`);
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(Buffer.from(bytes));
  });
  app.delete('/v1/artifacts/:id', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'artifact:write');
    await service.remove(owner.id, params(request).id); return reply.code(204).send();
  });
  app.post('/v1/artifacts/:id/import', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'memory:write');
    const body = z.object({ scope: z.enum(['private', 'workspace', 'agent']), scopeId: z.string().optional() }).strict().parse(request.body);
    if (body.scope !== 'private' && (!body.scopeId || !await store.get(body.scope, body.scopeId, owner.id))) throw new DomainError('not_found', 'Knowledge scope not found', 404);
    const { row } = await service.read(owner.id, params(request).id);
    if (!row.data.pages?.some((page) => page.text.trim())) throw new DomainError('no_document_text', 'The document has no extractable text');
    const ids: string[] = [];
    for (const page of row.data.pages) {
      for (let offset = 0; offset < page.text.length; offset += 3000) {
        const id = `${row.id}:${body.scope}:${body.scopeId ?? 'self'}:${page.page}:${offset}`;
        if (!await store.get('memory', id, owner.id)) await store.create('memory', owner.id, { type: 'document', scope: body.scope, scopeId: body.scopeId, text: page.text.slice(offset, offset + 3000), source: `artifact:${row.id}#page=${page.page}`, validFrom: new Date().toISOString() }, id);
        ids.push(id);
      }
    }
    return reply.code(201).send({ data: { memoryIds: ids, sourceId: row.id } });
  });
}
