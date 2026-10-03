import { DomainError } from './contracts.js';
import type { Task } from './domain.js';
import type { Store } from './storage/store.js';

export type AutomationSource = NonNullable<Task['automationSource']>;
export type AutomationAuthorizationFailure = 'marked' | 'missing' | 'stale' | 'existing';

interface AuthorizationSourceRecord {
  enabled: boolean;
  version: number;
  authorizationFailedAt?: string;
  authorizationFailedVersion?: number;
  [key: string]: unknown;
}

export async function markAutomationAuthorizationFailed(
  store: Store,
  ownerId: string,
  source: AutomationSource,
  occurredAt: string,
): Promise<AutomationAuthorizationFailure> {
  const kind = source.type === 'schedule' ? 'automation_schedule' : 'event_trigger';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await store.get<AuthorizationSourceRecord>(kind, source.id, ownerId);
    if (!row) return 'missing';
    if (row.data.version !== source.version) return 'stale';
    if (row.data.authorizationFailedAt !== undefined) return 'existing';
    try {
      await store.put(kind, source.id, ownerId, {
        ...row.data,
        enabled: false,
        authorizationFailedAt: occurredAt,
        authorizationFailedVersion: source.version,
      }, row.revision);
      return 'marked';
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
    }
  }
  throw new DomainError('conflict', 'Automation authorization state changed; retry', 409);
}
