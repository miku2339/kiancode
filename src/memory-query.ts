import { DomainError } from './contracts.js';
import type { Memory } from './domain.js';
import type { Entity } from './storage/store.js';

const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' });

export interface MemoryContext {
  scope: 'private' | 'group';
  conversationId: string;
  workspaceId?: string;
  agentId?: string;
  prompt: string;
}

export interface MemoryListQuery {
  ownerId: string;
  purpose: 'list';
  q?: string;
  scope?: Memory['scope'];
  scopeId?: string;
  reviewStatus?: NonNullable<Memory['reviewStatus']>;
  includeExpired?: boolean;
  now?: number;
  limit: number;
  cursor?: string;
}

export interface RelevantMemoryQuery {
  ownerId: string;
  purpose: 'relevant';
  context: MemoryContext;
  now?: number;
  limit: number;
}

export type MemoryQuery = MemoryListQuery | RelevantMemoryQuery;

export interface MemoryQueryPage {
  rows: Array<Entity<Memory>>;
  nextCursor?: string;
}

export interface MemoryCursor {
  score: number;
  updatedAt: string;
  id: string;
}

export function boundedMemoryLimit(limit: number): number {
  return Math.max(1, Math.min(Number.isInteger(limit) ? limit : 12, 100));
}

export function memoryQueryTerms(prompt: string): string[] {
  const terms = new Set<string>();
  const text = prompt.toLowerCase();
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike && [...segment.segment].length >= 2) terms.add(segment.segment);
    if (terms.size >= 64) break;
  }
  for (const run of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    const characters = [...run];
    for (let index = 0; index + 1 < characters.length && terms.size < 64; index += 1) {
      terms.add(characters.slice(index, index + 2).join(''));
    }
    if (terms.size >= 64) break;
  }
  return [...terms];
}

export function memorySearchTerms(query: string): string[] {
  const terms = memoryQueryTerms(query);
  const fallback = query.trim().toLowerCase();
  return terms.length || !fallback ? terms : [fallback];
}

function active(memory: Memory, now: number): boolean {
  return !(Date.parse(memory.validFrom) > now || (memory.validTo && Date.parse(memory.validTo) <= now));
}

export function memoryApproved(memory: Memory): boolean {
  return memory.reviewStatus === undefined || memory.reviewStatus === 'approved';
}

export function memoryVisible(memory: Memory, context: MemoryContext, now: number): boolean {
  if (!memoryApproved(memory) || !active(memory, now)) return false;
  if (memory.scope === 'private') return context.scope === 'private';
  if (memory.scope === 'group') return context.scope === 'group' && memory.scopeId === context.conversationId;
  if (context.scope === 'group') return false;
  if (memory.scope === 'workspace') return Boolean(context.workspaceId && memory.scopeId === context.workspaceId);
  return Boolean(context.agentId && memory.scopeId === context.agentId);
}

export function memoryScore(memory: Memory, terms: string[], includeDefaults: boolean): number {
  if (includeDefaults && ['persona', 'preference'].includes(memory.type)) return 100;
  const text = memory.text.toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function memoryUpdatedAt(row: Entity<Memory>): string {
  return new Date(row.updatedAt).toISOString();
}

export function relevantMemory(
  rows: Array<Entity<Memory>>,
  context: MemoryContext,
  now = Date.now(),
  limit = 12,
): Array<Entity<Memory>> {
  const inScope = rows.filter((row) => memoryVisible(row.data, context, now));
  const replaced = new Set(inScope.map((row) => row.data.replacesId).filter((id): id is string => Boolean(id)));
  const terms = memoryQueryTerms(context.prompt);
  return inScope
    .filter((row) => !replaced.has(row.id))
    .map((row) => ({ row, score: memoryScore(row.data, terms, true) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || memoryUpdatedAt(right.row).localeCompare(memoryUpdatedAt(left.row))
      || right.row.id.localeCompare(left.row.id))
    .slice(0, boundedMemoryLimit(limit))
    .map(({ row }) => row);
}

export function encodeMemoryCursor(cursor: MemoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeMemoryCursor(value: string): MemoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Partial<MemoryCursor>;
    if (!Number.isInteger(parsed.score) || (parsed.score ?? -1) < 0 || typeof parsed.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.updatedAt)) || typeof parsed.id !== 'string' || !parsed.id) throw new Error();
    return { score: parsed.score!, updatedAt: new Date(parsed.updatedAt).toISOString(), id: parsed.id };
  } catch {
    throw new DomainError('invalid_cursor', 'Memory cursor is invalid', 400);
  }
}

function afterCursor(item: MemoryCursor, cursor: MemoryCursor): boolean {
  return item.score < cursor.score
    || (item.score === cursor.score && item.updatedAt < cursor.updatedAt)
    || (item.score === cursor.score && item.updatedAt === cursor.updatedAt && item.id < cursor.id);
}

export function listMemoryRows(rows: Array<Entity<Memory>>, query: MemoryListQuery): MemoryQueryPage {
  const limit = boundedMemoryLimit(query.limit);
  const now = query.now ?? Date.now();
  const terms = query.q ? memorySearchTerms(query.q) : [];
  const cursor = query.cursor ? decodeMemoryCursor(query.cursor) : undefined;
  const reviewStatus = query.reviewStatus ?? 'approved';
  const scored = rows
    .filter((row) => (!query.scope || row.data.scope === query.scope)
      && (!query.scopeId || row.data.scopeId === query.scopeId)
      && (row.data.reviewStatus ?? 'approved') === reviewStatus
      && (query.includeExpired || active(row.data, now)))
    .map((row) => ({ row, score: terms.length ? memoryScore(row.data, terms, false) : 0 }))
    .filter(({ score }) => !terms.length || score > 0)
    .sort((left, right) => right.score - left.score
      || memoryUpdatedAt(right.row).localeCompare(memoryUpdatedAt(left.row))
      || right.row.id.localeCompare(left.row.id))
    .filter(({ row, score }) => !cursor || afterCursor({ score, updatedAt: memoryUpdatedAt(row), id: row.id }, cursor));
  const page = scored.slice(0, limit + 1);
  const rowsPage = page.slice(0, limit);
  const last = rowsPage.at(-1);
  return {
    rows: rowsPage.map(({ row }) => row),
    ...(page.length > limit && last
      ? { nextCursor: encodeMemoryCursor({ score: last.score, updatedAt: memoryUpdatedAt(last.row), id: last.row.id }) }
      : {}),
  };
}
