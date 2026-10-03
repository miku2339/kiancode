import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { asNotDispatched, DomainError, isNotDispatched, notDispatched, type ToolContext, type ToolDefinition } from './contracts.js';
import type { Entity, Store } from './storage/store.js';

export interface WorkspaceWriteLease {
  id: string;
  epoch: number;
  holderId: string;
  expiresAt: string;
}

export interface WorkspaceWriteLeaseRecord extends WorkspaceWriteLease {
  workspaceId: string;
  taskId: string;
  state: 'active' | 'released' | 'unknown';
  verification?: { note: string; verifiedAt: string };
}

export class WorkspaceWriteLeaseService {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now, private readonly durationMs = 30_000) {}

  private id(ownerId: string, workspaceId: string): string {
    return createHash('sha256').update(`${ownerId}\0${workspaceId}`).digest('hex');
  }

  async get(ownerId: string, workspaceId: string): Promise<Entity<WorkspaceWriteLeaseRecord> | undefined> {
    return this.store.get('workspace_write_lease', this.id(ownerId, workspaceId), ownerId);
  }

  async acquire(context: ToolContext): Promise<WorkspaceWriteLease> {
    if (!context.workspace) throw new DomainError('workspace_required', 'Select a workspace before writing');
    const ownerId = context.principal.id;
    const id = this.id(ownerId, context.workspace.id);
    for (;;) {
      context.signal.throwIfAborted();
      const row = await this.get(ownerId, context.workspace.id);
      if (row?.data.state === 'unknown' || (row?.data.state === 'active' && Date.parse(row.data.expiresAt) <= this.now())) {
        if (row.data.state === 'active') {
          try { await this.store.put('workspace_write_lease', id, ownerId, { ...row.data, state: 'unknown' }, row.revision); }
          catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; }
        }
        throw notDispatched('workspace_writer_unverified', 'Previous workspace writer must be verified before another write', 409);
      }
      if (row?.data.state === 'active') {
        await delay(100, undefined, { signal: context.signal });
        continue;
      }
      const data: WorkspaceWriteLeaseRecord = {
        id, epoch: (row?.data.epoch ?? 0) + 1, holderId: randomUUID(),
        expiresAt: new Date(this.now() + this.durationMs).toISOString(),
        workspaceId: context.workspace.id, taskId: context.taskId, state: 'active',
      };
      try {
        if (row) await this.store.put('workspace_write_lease', id, ownerId, data, row.revision);
        else await this.store.create('workspace_write_lease', ownerId, data, id);
        return data;
      } catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; }
    }
  }

  async validate(ownerId: string, workspaceId: string, taskId: string, lease: WorkspaceWriteLease): Promise<boolean> {
    const row = await this.get(ownerId, workspaceId);
    return Boolean(row && row.data.state === 'active' && row.data.taskId === taskId
      && row.data.id === lease.id && row.data.epoch === lease.epoch && row.data.holderId === lease.holderId
      && Date.parse(row.data.expiresAt) > this.now());
  }

  async reconcile(ownerId: string, workspaceId: string, revision: number, note: string): Promise<Entity<WorkspaceWriteLeaseRecord>> {
    const row = await this.get(ownerId, workspaceId);
    if (!row) throw new DomainError('not_found', 'Workspace writer lease not found', 404);
    if (row.revision !== revision) throw new DomainError('conflict', 'Workspace writer lease changed', 409);
    if (row.data.state === 'active' && Date.parse(row.data.expiresAt) > this.now()) {
      throw new DomainError('workspace_busy', 'Workspace writer is still active', 409);
    }
    const task = await this.store.get<{ state: string }>('task', row.data.taskId, ownerId);
    if (task?.data.state === 'running') {
      throw new DomainError('workspace_busy', 'Stop or recover the writing task before reconciling its lease', 409);
    }
    const jobs = await this.store.scan<{ job: { workspaceWriteLease?: WorkspaceWriteLease }; state: string }>('device_job', ownerId);
    if (jobs.some((job) => job.data.job.workspaceWriteLease?.holderId === row.data.holderId
      && ['queued', 'dispatched', 'unknown'].includes(job.data.state))) {
      throw new DomainError('outcome_unknown', 'Device operation still requires a confirmed outcome', 409);
    }
    return this.store.put('workspace_write_lease', row.id, ownerId, {
      ...row.data, state: 'released', verification: { note, verifiedAt: new Date(this.now()).toISOString() },
    }, revision);
  }

  private async update(context: ToolContext, lease: WorkspaceWriteLease, state: WorkspaceWriteLeaseRecord['state']): Promise<void> {
    const row = await this.get(context.principal.id, context.workspace!.id);
    if (!row || row.data.state !== 'active' || Date.parse(row.data.expiresAt) <= this.now()
      || row.data.taskId !== context.taskId || row.data.epoch !== lease.epoch || row.data.holderId !== lease.holderId) {
      throw new DomainError('outcome_unknown', 'Workspace writer no longer owns its lease', 409);
    }
    await this.store.put('workspace_write_lease', row.id, row.ownerId, {
      ...row.data, state, expiresAt: new Date(this.now() + this.durationMs).toISOString(),
    }, row.revision);
  }

  wrap(tool: ToolDefinition): ToolDefinition {
    if (!tool.requiresWorkspace || tool.sideEffect === 'read') return tool;
    return { ...tool, execute: async (input, context) => {
      const lease = await this.acquire(context).catch((error: unknown) => {
        throw asNotDispatched(error, 'workspace_lease_unavailable', 409);
      });
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      let renewal = Promise.resolve();
      const timer = setInterval(() => {
        renewal = renewal.then(() => this.update(context, lease, 'active')).catch((error) => { controller.abort(error); });
      }, Math.max(10, Math.floor(this.durationMs / 3)));
      timer.unref();
      let started = false;
      try {
        signal.throwIfAborted();
        started = true;
        const result = await tool.execute(input, { ...context, signal, workspaceWriteLease: lease });
        signal.throwIfAborted();
        clearInterval(timer); await renewal;
        await this.update(context, lease, 'released');
        return result;
      } catch (error) {
        clearInterval(timer); await renewal;
        const untouched = !started || isNotDispatched(error)
          || (error instanceof DomainError && error.code === 'waiting_for_device');
        await this.update(context, lease, untouched ? 'released' : 'unknown');
        throw started ? error : asNotDispatched(error, 'workspace_lease_unavailable', 409);
      } finally { clearInterval(timer); }
    } };
  }
}
