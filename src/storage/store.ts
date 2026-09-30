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
  put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>>;
  remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean>;
  close(): Promise<void>;
}
