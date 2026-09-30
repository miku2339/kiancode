import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../contracts.js';
import type { Memory } from '../domain.js';
import { listMemoryRows, relevantMemory, type MemoryQuery, type MemoryQueryPage } from '../memory-query.js';
import type { Entity, Store } from './store.js';

type Row = { id: string; owner_id: string; revision: number; created_at: string; updated_at: string; data: string };

function decode<T>(row: Row): Entity<T> {
  return { id: row.id, ownerId: row.owner_id, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at, data: JSON.parse(row.data) as T };
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  private closed = false;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY (kind, id)
      ); CREATE INDEX IF NOT EXISTS entities_owner_kind ON entities(owner_id,kind);`);
  }

  async create<T>(kind: string, ownerId: string, data: T, id: string = randomUUID()): Promise<Entity<T>> {
    const now = new Date().toISOString();
    try {
      this.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?)').run(kind, id, ownerId, 1, now, now, JSON.stringify(data));
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new DomainError('conflict', 'Record already exists', 409);
      throw error;
    }
    return { id, ownerId, data, revision: 1, createdAt: now, updatedAt: now };
  }

  async get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    const row = this.db.prepare('SELECT * FROM entities WHERE kind=? AND id=? AND owner_id=?').get(kind, id, ownerId) as Row | undefined;
    return row ? decode<T>(row) : undefined;
  }

  async scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    const rows = ownerId === undefined
      ? this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY created_at,id').all(kind)
      : this.db.prepare('SELECT * FROM entities WHERE kind=? AND owner_id=? ORDER BY created_at,id').all(kind, ownerId);
    return (rows as Row[]).map(decode<T>);
  }

  async queryMemory(query: MemoryQuery): Promise<MemoryQueryPage> {
    const rows = await this.scan<Memory>('memory', query.ownerId);
    if (query.purpose === 'relevant') {
      return { rows: relevantMemory(rows, query.context, query.now, query.limit) };
    }
    return listMemoryRows(rows, query);
  }

  async put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>> {
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE entities SET data=?,updated_at=?,revision=revision+1 WHERE kind=? AND id=? AND owner_id=? AND revision=?')
      .run(JSON.stringify(data), now, kind, id, ownerId, expectedRevision);
    if (Number(result.changes) === 0) {
      if (!await this.get(kind, id, ownerId)) throw new DomainError('not_found', 'Record not found', 404);
      throw new DomainError('conflict', 'Revision conflict', 409);
    }
    return (await this.get<T>(kind, id, ownerId))!;
  }

  async remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM entities WHERE kind=? AND id=? AND owner_id=? AND revision=?').run(kind, id, ownerId, expectedRevision);
    if (Number(result.changes) === 0 && await this.get(kind, id, ownerId)) throw new DomainError('conflict', 'Revision conflict', 409);
    return Number(result.changes) > 0;
  }

  async close(): Promise<void> {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
