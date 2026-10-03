import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { requireScope } from './auth.js';
import { DomainError, type Principal } from './contracts.js';
import type { Store } from './storage/store.js';
import { type BlobStore, sha256 } from './storage/blobs.js';

export interface Artifact { name: string; mimeType: string; bytes: number; sha256: string; storageId: string; source: 'upload' | 'tool'; producerTaskId?: string; pages?: Array<{ page: number; text: string }>; extractionError?: string }

export interface DocumentExtractionOptions {
  workerUrl?: URL;
  timeoutMs?: number;
}

type DocumentPage = { page: number; text: string };

interface ExtractionJob {
  run(): Promise<DocumentPage[]>;
  resolve(pages: DocumentPage[]): void;
  reject(error: unknown): void;
}

const documentInputLimit = 32 * 1024 * 1024;
const documentOutputLimit = 8 * 1024 * 1024;
const documentErrorOutputLimit = 64 * 1024;
const documentTextLimit = 1_000_000;
const documentPageLimit = 200;
const documentTimeoutMs = 15_000;
const waitingExtractions: ExtractionJob[] = [];
let activeExtractions = 0;

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

export async function extractDocument(
  bytes: Uint8Array,
  mimeType: string,
  options: DocumentExtractionOptions = {},
): Promise<DocumentPage[]> {
  if (bytes.byteLength > documentInputLimit) {
    throw new DomainError('document_too_large', 'Document exceeds 32 MB', 413);
  }
  if (mimeType.startsWith('text/') || ['application/json', 'application/xml'].includes(mimeType)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.length > documentTextLimit) throw new DomainError('document_too_large', 'Document text exceeds 1,000,000 characters', 413);
    return [{ page: 1, text }];
  }
  if (mimeType !== 'application/pdf' && mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return [];
  if (mimeType === 'application/pdf' && !Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) throw new DomainError('invalid_document', 'Invalid PDF header');
  if (mimeType.endsWith('document')) validateDocx(bytes);
  const workerUrl = options.workerUrl
    ?? new URL(import.meta.url.endsWith('.ts') ? './document-worker.ts' : './document-worker.js', import.meta.url);
  return enqueueExtraction(() => runDocumentWorker(bytes, mimeType, workerUrl, options.timeoutMs ?? documentTimeoutMs));
}

function enqueueExtraction(run: () => Promise<DocumentPage[]>): Promise<DocumentPage[]> {
  return new Promise((resolve, reject) => {
    const job = { run, resolve, reject };
    if (activeExtractions > 0) {
      if (waitingExtractions.length > 0) {
        reject(new DomainError('extraction_busy', 'Document extraction queue is full', 503));
        return;
      }
      waitingExtractions.push(job);
      return;
    }
    startExtraction(job);
  });
}

function startExtraction(job: ExtractionJob): void {
  activeExtractions = 1;
  void job.run().then(job.resolve, job.reject).finally(() => {
    activeExtractions = 0;
    const next = waitingExtractions.shift();
    if (next) startExtraction(next);
  });
}

function runDocumentWorker(
  bytes: Uint8Array,
  mimeType: string,
  workerUrl: URL,
  timeoutMs: number,
): Promise<DocumentPage[]> {
  return new Promise((resolve, reject) => {
    const arguments_ = ['--max-old-space-size=192'];
    if (workerUrl.pathname.endsWith('.ts')) arguments_.push('--import=tsx');
    arguments_.push(fileURLToPath(workerUrl), mimeType);
    const child = spawn(process.execPath, arguments_, {
      env: documentWorkerEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let errorOutputBytes = 0;
    let forcedError: unknown;
    let settled = false;
    const stop = (error: unknown): void => {
      forcedError ??= error;
      if (!child.killed) child.kill('SIGKILL');
    };
    const finish = (error?: unknown, pages?: DocumentPage[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(pages ?? []);
    };
    const timer = setTimeout(() => {
      stop(new DomainError('extraction_timeout', 'Document extraction exceeded its time limit'));
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > documentOutputLimit) {
        stop(new DomainError('extraction_failed', 'Document worker output exceeded its limit'));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorOutputBytes += chunk.byteLength;
      if (errorOutputBytes > documentErrorOutputLimit) {
        stop(new DomainError('extraction_failed', 'Document worker error output exceeded its limit'));
      }
    });
    child.stdin.on('error', () => {
      stop(new DomainError('extraction_failed', 'Document worker stopped while receiving input'));
    });
    child.once('error', () => {
      finish(new DomainError('extraction_failed', 'Document worker could not be started'));
    });
    child.once('close', (code) => {
      if (forcedError !== undefined) {
        finish(forcedError);
        return;
      }
      if (code !== 0) {
        finish(new DomainError('extraction_failed', 'Document worker stopped before completion'));
        return;
      }
      try {
        finish(undefined, parseDocumentWorkerOutput(Buffer.concat(output).toString('utf8')));
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.end(Buffer.from(bytes));
  });
}

function parseDocumentWorkerOutput(output: string): DocumentPage[] {
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch {
    throw new DomainError('extraction_failed', 'Document worker returned invalid output');
  }
  if (!result || typeof result !== 'object') {
    throw new DomainError('extraction_failed', 'Document worker returned invalid output');
  }
  const error = (result as { error?: unknown }).error;
  if (typeof error === 'string' && error) {
    throw new DomainError('extraction_failed', error.slice(0, 500));
  }
  const pages = (result as { pages?: unknown }).pages;
  if (!Array.isArray(pages) || pages.length > documentPageLimit) {
    throw new DomainError('extraction_failed', 'Document worker returned invalid output');
  }
  let textLength = 0;
  for (const page of pages) {
    if (!page || typeof page !== 'object'
      || !Number.isInteger((page as DocumentPage).page)
      || (page as DocumentPage).page < 1
      || typeof (page as DocumentPage).text !== 'string') {
      throw new DomainError('extraction_failed', 'Document worker returned invalid output');
    }
    textLength += (page as DocumentPage).text.length;
    if (textLength > documentTextLimit) {
      throw new DomainError('extraction_failed', 'Document worker returned too much text');
    }
  }
  return pages as DocumentPage[];
}

function documentWorkerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'LANG', 'LC_ALL']
    .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
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
