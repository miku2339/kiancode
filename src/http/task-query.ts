import { z } from 'zod';
import { DomainError } from '../contracts.js';
import type { Task } from '../domain.js';

export const taskQuerySchema = z.object({
  workspaceId: z.string().min(1).max(200).optional(),
  conversationId: z.string().min(1).max(200).optional(),
  state: z.enum(['queued', 'running', 'waiting_for_device', 'waiting_for_approval', 'waiting_for_children', 'paused', 'completed', 'failed', 'cancelled', 'unknown']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(1000).optional(),
  updatedAfter: z.iso.datetime().optional(),
}).strict();

export function taskPage<T extends { id: string; updatedAt: string; data: Pick<Task, 'workspaceId' | 'conversationId' | 'state'> }>(rows: T[], query: z.infer<typeof taskQuerySchema>): { data: T[]; nextCursor?: string } {
  let boundary: { updatedAt: string; id: string } | undefined;
  if (query.cursor) {
    try {
      boundary = z.object({ updatedAt: z.iso.datetime(), id: z.string().min(1).max(200) }).strict()
        .parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
    } catch { throw new DomainError('invalid_cursor', 'Task cursor is invalid'); }
  }
  const filtered = rows.filter((row) => (!query.workspaceId || row.data.workspaceId === query.workspaceId)
    && (!query.conversationId || row.data.conversationId === query.conversationId)
    && (!query.state || row.data.state === query.state)
    && (!query.updatedAfter || Date.parse(row.updatedAt) > Date.parse(query.updatedAfter)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
    .filter((row) => !boundary || row.updatedAt < boundary.updatedAt || (row.updatedAt === boundary.updatedAt && row.id < boundary.id));
  const data = query.limit ? filtered.slice(0, query.limit) : filtered;
  const last = data.at(-1);
  const nextCursor = last && data.length < filtered.length
    ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url')
    : undefined;
  return { data, ...(nextCursor ? { nextCursor } : {}) };
}
