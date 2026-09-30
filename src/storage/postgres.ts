import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DomainError } from '../contracts.js';
import type { Memory } from '../domain.js';
import {
  boundedMemoryLimit,
  decodeMemoryCursor,
  encodeMemoryCursor,
  memoryQueryTerms,
  memorySearchTerms,
  type MemoryListQuery,
  type MemoryQuery,
  type MemoryQueryPage,
  type RelevantMemoryQuery,
} from '../memory-query.js';
import type { Entity, Store } from './store.js';

type Row = { id: string; owner_id: string; revision: number; created_at: Date; updated_at: Date; data: unknown };
type ScoredRow = Row & { score: number | string };
function decode<T>(row: Row): Entity<T> {
  return { id: row.id, ownerId: row.owner_id, revision: Number(row.revision), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), data: row.data as T };
}

export class PostgresStore implements Store {
  private constructor(private pool: Pool) {}

  static async connect(connectionString: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 });
    try {
      const schema = await pool.query<{ table_exists: boolean; index_exists: boolean }>(`
        SELECT to_regclass('kiancode_entities') IS NOT NULL AS table_exists,
          to_regclass('kiancode_entities_owner_kind') IS NOT NULL AS index_exists
      `);
      if (!schema.rows[0]?.table_exists) {
        await pool.query(`CREATE TABLE IF NOT EXISTS kiancode_entities (
          kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL,
          revision BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
          data JSONB NOT NULL, PRIMARY KEY(kind,id));
          CREATE INDEX IF NOT EXISTS kiancode_entities_owner_kind ON kiancode_entities(owner_id,kind);`);
      } else if (!schema.rows[0].index_exists) {
        await pool.query('CREATE INDEX IF NOT EXISTS kiancode_entities_owner_kind ON kiancode_entities(owner_id,kind)');
      }
      return new PostgresStore(pool);
    } catch (error) { await pool.end(); throw error; }
  }

  async create<T>(kind: string, ownerId: string, data: T, id: string = randomUUID()): Promise<Entity<T>> {
    try {
      const result = await this.pool.query<Row>('INSERT INTO kiancode_entities VALUES ($1,$2,$3,1,NOW(),NOW(),$4) RETURNING *', [kind, id, ownerId, JSON.stringify(data)]);
      return decode<T>(result.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('conflict', 'Record already exists', 409);
      throw error;
    }
  }

  async get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    const result = await this.pool.query<Row>('SELECT * FROM kiancode_entities WHERE kind=$1 AND id=$2 AND owner_id=$3', [kind, id, ownerId]);
    return result.rows[0] ? decode<T>(result.rows[0]) : undefined;
  }

  async scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    const result = ownerId === undefined
      ? await this.pool.query<Row>('SELECT * FROM kiancode_entities WHERE kind=$1 ORDER BY created_at,id', [kind])
      : await this.pool.query<Row>('SELECT * FROM kiancode_entities WHERE kind=$1 AND owner_id=$2 ORDER BY created_at,id', [kind, ownerId]);
    return result.rows.map(decode<T>);
  }

  async queryMemory(query: MemoryQuery): Promise<MemoryQueryPage> {
    return query.purpose === 'relevant' ? this.relevantMemory(query) : this.listMemory(query);
  }

  private async relevantMemory(query: RelevantMemoryQuery): Promise<MemoryQueryPage> {
    const now = new Date(query.now ?? Date.now()).toISOString();
    const terms = memoryQueryTerms(query.context.prompt);
    const values = [
      query.ownerId,
      now,
      query.context.scope,
      query.context.conversationId,
      query.context.workspaceId ?? null,
      query.context.agentId ?? null,
      terms,
      boundedMemoryLimit(query.limit),
    ];
    const visible = (alias: string) => `(
      ($3 = 'private' AND (
        ${alias}.data->>'scope' = 'private'
        OR ($5::text IS NOT NULL AND ${alias}.data->>'scope' = 'workspace' AND ${alias}.data->>'scopeId' = $5)
        OR ($6::text IS NOT NULL AND ${alias}.data->>'scope' = 'agent' AND ${alias}.data->>'scopeId' = $6)
      ))
      OR ($3 = 'group' AND ${alias}.data->>'scope' = 'group' AND ${alias}.data->>'scopeId' = $4)
    )`;
    const active = (alias: string) => `(
      coalesce(${alias}.data->>'validFrom', '') <= $2
      AND (${alias}.data->>'validTo' IS NULL OR ${alias}.data->>'validTo' > $2)
    )`;
    const result = await this.pool.query<ScoredRow>(`
      WITH scoped AS MATERIALIZED (
        SELECT e.*
        FROM kiancode_entities e
        WHERE e.kind = 'memory' AND e.owner_id = $1
          AND coalesce(e.data->>'reviewStatus', 'approved') = 'approved'
          AND ${active('e')} AND ${visible('e')}
      ), unreplaced AS (
        SELECT memory.*
        FROM scoped memory
        LEFT JOIN (
          SELECT DISTINCT data->>'replacesId' AS id
          FROM scoped
          WHERE data->>'replacesId' IS NOT NULL
        ) replacement ON replacement.id = memory.id
        WHERE replacement.id IS NULL
      ), ranked AS (
        SELECT e.*,
          CASE WHEN e.data->>'type' IN ('persona', 'preference') THEN 100
            ELSE (SELECT count(*)::int FROM unnest($7::text[]) AS term
              WHERE strpos(lower(coalesce(e.data->>'text', '')), term) > 0)
          END AS score
        FROM unreplaced e
      )
      SELECT * FROM ranked WHERE score > 0
      ORDER BY score DESC, date_trunc('milliseconds', updated_at) DESC, id DESC
      LIMIT $8
    `, values);
    return { rows: result.rows.map(decode<Memory>) };
  }

  private async listMemory(query: MemoryListQuery): Promise<MemoryQueryPage> {
    const limit = boundedMemoryLimit(query.limit);
    const terms = query.q ? memorySearchTerms(query.q) : [];
    const cursor = query.cursor ? decodeMemoryCursor(query.cursor) : undefined;
    const result = await this.pool.query<ScoredRow>(`
      WITH ranked AS (
        SELECT e.*,
          CASE WHEN $7::boolean THEN (SELECT count(*)::int FROM unnest($6::text[]) AS term
            WHERE strpos(lower(coalesce(e.data->>'text', '')), term) > 0)
          ELSE 0 END AS score
        FROM kiancode_entities e
        WHERE e.kind = 'memory' AND e.owner_id = $1
          AND ($3::text IS NULL OR e.data->>'scope' = $3)
          AND ($4::text IS NULL OR e.data->>'scopeId' = $4)
          AND coalesce(e.data->>'reviewStatus', 'approved') = coalesce($12::text, 'approved')
          AND ($5::boolean OR (
            coalesce(e.data->>'validFrom', '') <= $2
            AND (e.data->>'validTo' IS NULL OR e.data->>'validTo' > $2)
          ))
      )
      SELECT * FROM ranked
      WHERE (NOT $7::boolean OR score > 0)
        AND ($8::int IS NULL
          OR score < $8
          OR (score = $8 AND date_trunc('milliseconds', updated_at) < $9::timestamptz)
          OR (score = $8 AND date_trunc('milliseconds', updated_at) = $9::timestamptz AND id < $10))
      ORDER BY score DESC, date_trunc('milliseconds', updated_at) DESC, id DESC
      LIMIT $11
    `, [
      query.ownerId,
      new Date(query.now ?? Date.now()).toISOString(),
      query.scope ?? null,
      query.scopeId ?? null,
      query.includeExpired ?? false,
      terms,
      terms.length > 0,
      cursor?.score ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
      query.reviewStatus ?? null,
    ]);
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map(decode<Memory>),
      ...(result.rows.length > limit && last
        ? { nextCursor: encodeMemoryCursor({ score: Number(last.score), updatedAt: last.updated_at.toISOString(), id: last.id }) }
        : {}),
    };
  }

  async put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>> {
    const result = await this.pool.query<Row>('UPDATE kiancode_entities SET data=$1,updated_at=NOW(),revision=revision+1 WHERE kind=$2 AND id=$3 AND owner_id=$4 AND revision=$5 RETURNING *', [JSON.stringify(data), kind, id, ownerId, expectedRevision]);
    if (result.rows[0]) return decode<T>(result.rows[0]);
    if (!await this.get(kind, id, ownerId)) throw new DomainError('not_found', 'Record not found', 404);
    throw new DomainError('conflict', 'Revision conflict', 409);
  }

  async remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM kiancode_entities WHERE kind=$1 AND id=$2 AND owner_id=$3 AND revision=$4', [kind, id, ownerId, expectedRevision]);
    if (!result.rowCount && await this.get(kind, id, ownerId)) throw new DomainError('conflict', 'Revision conflict', 409);
    return Boolean(result.rowCount);
  }

  async close(): Promise<void> { await this.pool.end(); }
}
