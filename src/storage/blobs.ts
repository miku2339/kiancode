import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '../contracts.js';

export interface BlobStore { put(id: string, data: Uint8Array): Promise<string>; get(id: string): Promise<Uint8Array>; remove(id: string): Promise<void> }
const safeId = (id: string) => { if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw new DomainError('invalid_blob_id', 'Invalid attachment identifier'); return id; };
export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

export class LocalBlobStore implements BlobStore {
  constructor(private directory: string) {}
  async put(id: string, data: Uint8Array) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, safeId(id));
    const digest = sha256(data);
    try { if (sha256(await readFile(target)) === digest) return digest; throw new DomainError('conflict', 'Attachment identifier already contains different data', 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = path.join(this.directory, `${id}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (sha256(await readFile(target)) !== digest) throw new DomainError('conflict', 'Attachment identifier already contains different data', 409);
      }
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await unlink(temporary).catch(() => {}); }
    return digest;
  }
  async get(id: string) { return readFile(path.join(this.directory, safeId(id))); }
  async remove(id: string) { await unlink(path.join(this.directory, safeId(id))).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

export class HttpBlobStore implements BlobStore {
  private endpoint: URL;
  constructor(endpoint: string, private token: string) {
    this.endpoint = new URL(endpoint);
    if (this.endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname)) throw new Error('Attachment service requires HTTPS');
    if (token.length < 32) throw new Error('Attachment service token must have at least 32 characters');
  }
  private async request(method: string, id: string, data?: Uint8Array) {
    const response = await fetch(new URL(`/v1/blobs/${safeId(id)}`, this.endpoint), { method, headers: { authorization: `Bearer ${this.token}`, ...(data ? { 'content-type': 'application/octet-stream' } : {}) }, body: data ? Buffer.from(data) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new DomainError('storage_unavailable', `Attachment service returned HTTP ${response.status}`, 503);
    return response;
  }
  async put(id: string, data: Uint8Array) {
    const result = await (await this.request('PUT', id, data)).json() as { sha256: string };
    if (result.sha256 !== sha256(data)) throw new DomainError('storage_integrity', 'Attachment service did not confirm the expected checksum', 503);
    return result.sha256;
  }
  async get(id: string) { return new Uint8Array(await (await this.request('GET', id)).arrayBuffer()); }
  async remove(id: string) { await this.request('DELETE', id); }
}
