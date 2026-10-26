import type { TaskEvent } from '../domain.js';
import type { MemoryQuery, MemoryQueryPage } from '../memory-query.js';

export interface Entity<T = Record<string, unknown>> {
  id: string;
  ownerId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  data: T;
}

export interface Store {
  create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>>;
  get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined>;
  scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>>;
  queryMemory?(query: MemoryQuery): Promise<MemoryQueryPage>;
  taskEvents?(ownerId: string, taskId: string, after?: number): Promise<Array<Entity<TaskEvent>>>;
  put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>>;
  remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean>;
  close(): Promise<void>;
}

export async function taskEvents(store: Store, ownerId: string, taskId: string, after = 0): Promise<Array<Entity<TaskEvent>>> {
  if (store.taskEvents) return store.taskEvents(ownerId, taskId, after);
  return (await store.scan<TaskEvent>('event', ownerId))
    .filter((row) => row.data.taskId === taskId && row.data.sequence > after)
    .sort((left, right) => left.data.sequence - right.data.sequence);
}
