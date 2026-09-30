import { requireOwner, requireScope } from './auth.js';
import type { Principal } from './contracts.js';
import type { Store } from './storage/store.js';
import type { Task } from './domain.js';
import type { Artifact } from './artifacts.js';

export interface MaintenanceActivity {
  method: string;
  route: string;
  statusCode: number;
  requestId: string;
  at: string;
}
export interface BackupReport {
  completedAt: string;
  state: 'verified' | 'failed';
  database: string;
  filename: string;
  sha256?: string;
  bytes?: number;
  restoredEntities?: number;
  restoredArtifacts?: number;
  retained?: boolean;
  errorCode?: string;
}
export interface ReleaseReport {
  release: string;
  activatedAt: string;
  state: 'active' | 'previous';
  coreVersion: string;
}

export class MaintenanceService {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  async status(actor: Principal) {
    this.read(actor);
    const [tasks, devices, artifacts, backups, releases] = await Promise.all([
      this.store.scan<Task>('task', actor.id),
      this.store.scan<{ name: string; paused: boolean; revokedAt?: string; lastSeen?: string }>('device', actor.id),
      this.store.scan<Artifact>('artifact', actor.id),
      this.store.scan<BackupReport>('maintenance_backup', '_maintenance'),
      this.store.scan<ReleaseReport>('maintenance_release', '_maintenance'),
    ]);
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[task.data.state] = (counts[task.data.state] ?? 0) + 1;
    return {
      checkedAt: new Date(this.now()).toISOString(),
      storage: { state: 'connected', artifactCount: artifacts.length, artifactBytes: artifacts.reduce((total, row) => total + row.data.bytes, 0) },
      tasks: { total: tasks.length, states: counts },
      attention: tasks.filter((row) => ['failed', 'unknown', 'waiting_for_device', 'waiting_for_approval'].includes(row.data.state))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 100)
        .map((row) => ({ id: row.id, conversationId: row.data.conversationId, state: row.data.state, updatedAt: row.updatedAt, error: row.data.error })),
      devices: devices.map((row) => ({ id: row.id, name: row.data.name, status: row.data.revokedAt ? 'revoked' : row.data.paused ? 'paused' : row.data.lastSeen && this.now() - Date.parse(row.data.lastSeen) <= 45_000 ? 'online' : 'offline', lastSeen: row.data.lastSeen })),
      backups: backups.sort((left, right) => right.data.completedAt.localeCompare(left.data.completedAt)).slice(0, 30),
      releases: releases.sort((left, right) => right.data.activatedAt.localeCompare(left.data.activatedAt)).slice(0, 2),
    };
  }

  async activity(actor: Principal, before?: string, limit = 100) {
    this.read(actor);
    return (await this.store.scan<MaintenanceActivity>('maintenance_activity', actor.id))
      .filter((row) => !before || row.data.at < before)
      .sort((left, right) => right.data.at.localeCompare(left.data.at) || right.id.localeCompare(left.id))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  async record(actor: Principal, event: Omit<MaintenanceActivity, 'at'>): Promise<void> {
    if (!/^\/(?:v1|api)\/[a-zA-Z0-9_:/.-]{1,200}$/.test(event.route)
      || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.method)) return;
    await this.store.create('maintenance_activity', actor.id, { ...event, requestId: event.requestId.slice(0, 128), at: new Date(this.now()).toISOString() });
  }

  async cleanExpiredActivity(actor: Principal): Promise<{ removedActivity: number; removedProbes: number }> {
    this.read(actor); requireScope(actor, 'maintenance:write');
    let removedActivity = 0; let removedProbes = 0;
    for (const row of await this.store.scan<MaintenanceActivity>('maintenance_activity', actor.id)) {
      if (Date.parse(row.data.at) < this.now() - 90 * 86_400_000) {
        if (await this.store.remove('maintenance_activity', row.id, actor.id, row.revision)) removedActivity += 1;
      }
    }
    for (const row of await this.store.scan<{ state: string; expiresAt: string }>('model_probe', actor.id)) {
      if (row.data.state === 'finished' && Date.parse(row.data.expiresAt) < this.now() - 7 * 86_400_000) {
        if (await this.store.remove('model_probe', row.id, actor.id, row.revision)) removedProbes += 1;
      }
    }
    return { removedActivity, removedProbes };
  }

  private read(actor: Principal): void { requireOwner(actor); requireScope(actor, 'maintenance:read'); }
}
