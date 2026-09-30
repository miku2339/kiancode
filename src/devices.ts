import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bearer, requireScope, tokenHash } from './auth.js';
import { DomainError, type Principal, type ToolContext, type ToolDefinition, type ToolResult } from './contracts.js';
import type { DeviceJob, DeviceJobResult, DevicePairRequest, InlineDeviceArtifact } from './connectors/device.js';
import type { Entity, Store } from './storage/store.js';
import type { EphemeralModelPayload, EphemeralPayloadStore } from './runtime/visual-context.js';
import type { ArtifactService } from './artifacts.js';
import type { WorkspaceWriteLeaseService } from './workspace-write-lease.js';
import {
  MAX_WORKSPACE_EXPORT_BYTES,
  validateWorkspaceExport,
  WORKSPACE_EXPORT_MIME_TYPES,
  workspaceExportMimeType,
} from './tools/workspace-export.js';

interface Device { name: string; capabilities: string[]; reportedCapabilities: string[]; workspaceIds: string[]; lastSeen?: string; revokedAt?: string; paused: boolean }
interface Pairing { ownerId: string; capabilities: string[]; workspaceIds: string[]; expiresAt: string; usedAt?: string }
interface Credential { ownerId: string; deviceId: string }
interface Job { job: DeviceJob; state: 'queued' | 'dispatched' | DeviceJobResult['status']; result?: ToolResult; error?: string }
const internalOwner = '_device_credentials';
const deviceParams = z.object({ id: z.string().min(1).max(200) });

export class DeviceService {
  private writeLeases?: WorkspaceWriteLeaseService;
  constructor(
    private store: Store,
    private now: () => number = Date.now,
    private ephemeralPayloads?: EphemeralPayloadStore,
    private artifacts?: ArtifactService,
  ) {}

  setArtifactService(artifacts: ArtifactService): void { this.artifacts = artifacts; }
  setWriteLeaseService(service: WorkspaceWriteLeaseService): void { this.writeLeases = service; }

  async validateWriteLease(device: Entity<Device>, jobId: string): Promise<{ valid: boolean }> {
    const row = await this.store.get<Job>('device_job', jobId, device.ownerId);
    if (!row || row.data.job.deviceId !== device.id) throw new DomainError('not_found', 'Job not found', 404);
    const job = row.data.job;
    const lease = job.workspaceWriteLease;
    const workspace = job.workspace && await this.store.get<{ capabilities: string[]; deviceId: string }>('workspace', job.workspace.id, device.ownerId);
    return { valid: Boolean(lease && job.workspace && this.writeLeases && !device.data.paused && !device.data.revokedAt
      && workspace && workspace.data.deviceId === device.id && device.data.workspaceIds.includes(job.workspace.id)
      && job.requiredCapabilities.every((capability) => workspace.data.capabilities.includes(capability)
        && device.data.capabilities.includes(capability) && device.data.reportedCapabilities.includes(capability))
      && row.data.state === 'dispatched' && await this.activeExecution(job, device.ownerId)
      && Date.parse(job.expiresAt) > this.now()
      && await this.writeLeases.validate(device.ownerId, job.workspace.id, job.taskId, lease)) };
  }

  async list(ownerId: string) { return this.store.scan<Device>('device', ownerId); }

  async createPairing(principal: Principal, capabilities: string[], workspaceIds: string[]) {
    requireScope(principal, 'device:write');
    for (const capability of capabilities) requireScope(principal, capability);
    for (const workspaceId of workspaceIds) {
      if (!await this.store.get('workspace', workspaceId, principal.id)) throw new DomainError('not_found', 'Workspace not found', 404);
    }
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.now() + 600000).toISOString();
    await this.store.create<Pairing>('pairing', internalOwner, { ownerId: principal.id, capabilities, workspaceIds, expiresAt }, tokenHash(code));
    return { code, expiresAt };
  }

  async pair(input: DevicePairRequest) {
    const row = await this.store.get<Pairing>('pairing', tokenHash(input.code), internalOwner);
    if (!row || row.data.usedAt || Date.parse(row.data.expiresAt) <= this.now()) throw new DomainError('invalid_pairing', 'Pairing code is invalid or expired', 401);
    if (input.capabilities.some((capability) => !row.data.capabilities.includes(capability))) throw new DomainError('forbidden', 'Pairing cannot add capabilities', 403);
    await this.store.put('pairing', row.id, internalOwner, { ...row.data, usedAt: new Date(this.now()).toISOString() }, row.revision);
    const device = await this.store.create<Device>('device', row.data.ownerId, {
      name: input.name, capabilities: row.data.capabilities, reportedCapabilities: input.capabilities, workspaceIds: row.data.workspaceIds,
      lastSeen: new Date(this.now()).toISOString(), paused: false,
    });
    const token = `kdt_${randomBytes(32).toString('base64url')}`;
    await this.store.create<Credential>('device_token', internalOwner, { ownerId: row.data.ownerId, deviceId: device.id }, tokenHash(token));
    return { deviceId: device.id, token, ownerId: row.data.ownerId };
  }

  async authenticate(authorization: string | undefined, deviceId: string): Promise<Entity<Device>> {
    const credential = await this.store.get<Credential>('device_token', tokenHash(bearer(authorization)), internalOwner);
    if (!credential || credential.data.deviceId !== deviceId) throw new DomainError('unauthorized', 'Invalid device token', 401);
    const device = await this.store.get<Device>('device', deviceId, credential.data.ownerId);
    if (!device || device.data.revokedAt) throw new DomainError('unauthorized', 'Device has been revoked', 401);
    return device;
  }

  async heartbeat(device: Entity<Device>, capabilities?: string[]) {
    if (capabilities?.some((capability) => !device.data.capabilities.includes(capability))) throw new DomainError('forbidden', 'Heartbeat cannot add capabilities', 403);
    await this.store.put('device', device.id, device.ownerId, { ...device.data, reportedCapabilities: capabilities ?? device.data.reportedCapabilities, lastSeen: new Date(this.now()).toISOString() }, device.revision);
    return { online: true as const, serverTime: new Date(this.now()).toISOString() };
  }

  async control(ownerId: string, deviceId: string, action: 'pause' | 'resume' | 'revoke') {
    const device = await this.store.get<Device>('device', deviceId, ownerId);
    if (!device) throw new DomainError('not_found', 'Device not found', 404);
    return this.store.put('device', deviceId, ownerId, { ...device.data, paused: action !== 'resume', revokedAt: action === 'revoke' ? new Date(this.now()).toISOString() : device.data.revokedAt }, device.revision);
  }

  async grant(principal: Principal, deviceId: string, workspaceIds: string[]) {
    requireScope(principal, 'device:write');
    const device = await this.store.get<Device>('device', deviceId, principal.id);
    if (!device || device.data.revokedAt) throw new DomainError('not_found', 'Active device not found', 404);
    for (const id of workspaceIds) {
      const workspace = await this.store.get<{ deviceId: string }>('workspace', id, principal.id);
      if (!workspace || workspace.data.deviceId !== deviceId) throw new DomainError('invalid_workspace', 'Workspace must belong to this device');
    }
    return this.store.put('device', deviceId, principal.id, { ...device.data, workspaceIds }, device.revision);
  }

  async poll(device: Entity<Device>): Promise<{ jobs: DeviceJob[] }> {
    if (device.data.paused) return { jobs: [] };
    const jobs: DeviceJob[] = [];
    for (const row of await this.store.scan<Job>('device_job', device.ownerId)) {
      if (row.data.job.deviceId !== device.id || row.data.state !== 'queued') continue;
      if (Date.parse(row.data.job.expiresAt) <= this.now()) {
        await this.store.put('device_job', row.id, row.ownerId, { ...row.data, state: 'cancelled', error: 'Expired before dispatch' }, row.revision);
        continue;
      }
      if (!await this.activeExecution(row.data.job, device.ownerId)) continue;
      const fence = row.data.job.workspaceWriteLease;
      if (fence && (!row.data.job.workspace || !this.writeLeases || !await this.writeLeases.validate(device.ownerId, row.data.job.workspace.id, row.data.job.taskId, fence))) {
        await this.store.put('device_job', row.id, row.ownerId, { ...row.data, state: 'failed', error: 'Workspace writer lease is no longer valid' }, row.revision);
        continue;
      }
      const job = { ...row.data.job, dispatchedAt: new Date(this.now()).toISOString() };
      try {
        const dispatched = await this.store.put<Job>(
          'device_job',
          row.id,
          row.ownerId,
          { ...row.data, job, state: 'dispatched' },
          row.revision,
        );
        const hydrated = this.hydrateEphemeralPayload(job, row.ownerId);
        if (!hydrated) {
          await this.store.put<Job>('device_job', row.id, row.ownerId, {
            ...dispatched.data,
            state: 'failed',
            result: { content: 'ephemeral_context_missing', isError: true },
            error: 'Ephemeral visual context is no longer available',
          }, dispatched.revision);
          continue;
        }
        jobs.push(hydrated);
      } catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; }
    }
    return { jobs };
  }

  async submit(device: Entity<Device>, jobId: string, result: DeviceJobResult) {
    const row = await this.store.get<Job>('device_job', jobId, device.ownerId);
    if (!row || row.data.job.deviceId !== device.id) throw new DomainError('not_found', 'Job not found', 404);
    if (result.result?.artifactIds?.length || result.result?.artifacts?.length) {
      throw new DomainError('invalid_result', 'Device cannot choose server artifact identifiers or send local paths');
    }
    const replay = row.data.state === result.status;
    if (!replay && !['dispatched', 'unknown'].includes(row.data.state)) throw new DomainError('conflict', 'Job result is already recorded', 409);
    let storedResult = result.result;
    if (result.inlineArtifacts?.length) {
      const screenshot = row.data.job.toolName === 'mac.app.screenshot'
        && row.data.job.requiredCapabilities.includes('screenshot:read');
      const workspaceExport = row.data.job.toolName === 'workspace.export'
        && row.data.job.requiredCapabilities.includes('workspace:export')
        && row.data.job.workspace?.capabilities.includes('workspace:export')
        && device.data.capabilities.includes('workspace:export')
        && device.data.reportedCapabilities.includes('workspace:export');
      if (result.status !== 'confirmed' || !storedResult || (!screenshot && !workspaceExport)) {
        throw new DomainError('invalid_device_artifact', 'Inline artifacts are allowed only for a confirmed authorized artifact job');
      }
      if (!this.artifacts) throw new DomainError('attachments_unavailable', 'Attachment storage is not configured', 503);
      if (result.inlineArtifacts.length !== 1) throw new DomainError('too_many_attachments', 'Device result must contain exactly one inline artifact', 413);
      let total = 0;
      const artifactIds: string[] = [];
      for (const [index, artifact] of result.inlineArtifacts.entries()) {
        const bytes = this.validateInlineArtifact(artifact, row.data.job);
        total += bytes.byteLength;
        if (total > 8 * 1024 * 1024) throw new DomainError('attachment_too_large', 'Device result artifacts exceed 8 MB', 413);
        const uploaded = await this.artifacts.upload(
          device.ownerId,
          artifact.name,
          artifact.mimeType,
          bytes,
          `device:${device.id}:job:${jobId}:artifact:${index}`,
          'tool',
          row.data.job.taskId,
        );
        artifactIds.push(uploaded.id);
      }
      storedResult = { ...storedResult, artifactIds };
    }
    if (row.data.state === result.status && JSON.stringify(row.data.result) === JSON.stringify(storedResult)) return;
    if (replay) throw new DomainError('conflict', 'Job result is already recorded with different content', 409);
    if (result.status === 'confirmed' && !result.result) throw new DomainError('invalid_result', 'Confirmed jobs require a result');
    await this.store.put('device_job', row.id, row.ownerId, { ...row.data, state: result.status, result: storedResult, error: result.error }, row.revision);
  }

  remoteTool(definition: Omit<ToolDefinition, 'execute'>): ToolDefinition {
    return { ...definition, execute: (input, context) => this.execute(definition, input, context) };
  }

  async executeModel(deviceId: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    requireScope(context.principal, 'model:generate');
    const device = await this.store.get<Device>('device', deviceId, context.principal.id);
    if (!device || device.data.revokedAt) throw new DomainError('device_revoked', 'Model device is no longer authorized', 403);
    if (!device.data.capabilities.includes('model:generate')) throw new DomainError('forbidden', 'Local model execution is not granted', 403);
    if (device.data.paused || !device.data.reportedCapabilities.includes('model:generate') || !device.data.lastSeen || this.now() - Date.parse(device.data.lastSeen) > 45000) throw new DomainError('waiting_for_device', 'Waiting for the authorized local model device');
    return this.dispatch({ id: randomUUID(), deviceId, principal: context.principal, taskId: context.taskId, toolName: 'model.generate', input, requiredCapabilities: ['model:generate'], expiresAt: new Date(this.now() + 300000).toISOString(), dispatchedAt: '' }, context);
  }

  async cancellations(device: Entity<Device>): Promise<string[]> {
    const ids: string[] = [];
    for (const row of await this.store.scan<Job>('device_job', device.ownerId)) {
      if (row.data.job.deviceId !== device.id || !['dispatched', 'unknown'].includes(row.data.state)) continue;
      if (device.data.paused || !await this.activeExecution(row.data.job, device.ownerId) || Date.parse(row.data.job.expiresAt) < this.now()) ids.push(row.id);
    }
    return ids;
  }

  private async activeExecution(job: DeviceJob, ownerId: string): Promise<boolean> {
    const task = await this.store.get<{ state: string }>('task', job.taskId, ownerId);
    if (task) return task.data.state === 'running';
    if (job.toolName !== 'model.generate' || !job.taskId.startsWith('model-probe:')) return false;
    const probe = await this.store.get<{ state: string; deviceId?: string; expiresAt: string }>('model_probe', job.taskId, ownerId);
    return Boolean(probe && probe.data.state === 'running' && probe.data.deviceId === job.deviceId && Date.parse(probe.data.expiresAt) > this.now());
  }

  private async execute(tool: Omit<ToolDefinition, 'execute'>, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const workspace = context.workspace;
    if (!workspace) throw new DomainError('workspace_required', 'Select a workspace before using device tools');
    const device = await this.store.get<Device>('device', workspace.deviceId, context.principal.id);
    if (!device) throw new DomainError('waiting_for_device', 'Waiting for an authorized workspace device');
    if (device.data.revokedAt) throw new DomainError('device_revoked', 'Device is no longer authorized', 403);
    if (device.data.paused || !device.data.lastSeen || this.now() - Date.parse(device.data.lastSeen) > 45000) throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect');
    if (!device.data.workspaceIds.includes(workspace.id)) throw new DomainError('workspace_denied', 'Workspace is not granted to this device', 403);
    for (const capability of tool.requiredCapabilities) {
      requireScope(context.principal, capability);
      if (!workspace.capabilities.includes(capability) || !device.data.capabilities.includes(capability)) throw new DomainError('forbidden', 'Tool capability is not granted', 403);
      if (!device.data.reportedCapabilities.includes(capability)) throw new DomainError('waiting_for_device', `Waiting for device capability ${capability}`);
    }
    const job: DeviceJob = { id: randomUUID(), deviceId: device.id, principal: context.principal, taskId: context.taskId, workspace, toolName: tool.name, input, requiredCapabilities: tool.requiredCapabilities, expiresAt: new Date(this.now() + 300000).toISOString(), dispatchedAt: '', workspaceWriteLease: context.workspaceWriteLease };
    return this.dispatch(job, context);
  }

  private async dispatch(job: DeviceJob, context: ToolContext): Promise<ToolResult> {
    const ownerId = context.principal.id;
    await this.store.create<Job>('device_job', ownerId, { job, state: 'queued' }, job.id);
    try {
      while (this.now() < Date.parse(job.expiresAt)) {
        context.signal.throwIfAborted();
        const row = await this.store.get<Job>('device_job', job.id, ownerId);
        if (!row) throw new DomainError('outcome_unknown', 'Device job record is unavailable');
        if (row.data.state === 'confirmed') return row.data.result!;
        if (row.data.state === 'failed') return row.data.result ?? { content: row.data.error ?? 'Device tool failed', isError: true };
        if (['unknown', 'cancelled'].includes(row.data.state)) throw new DomainError('outcome_unknown', row.data.error ?? 'Verify device operation before retrying');
        await delay(250, undefined, { signal: context.signal });
      }
      throw new DomainError('outcome_unknown', 'Device result timed out; verify before retrying');
    } catch (error) {
      const row = await this.store.get<Job>('device_job', job.id, ownerId);
      if (row && ['queued', 'dispatched'].includes(row.data.state)) {
        await this.store.put('device_job', row.id, row.ownerId, { ...row.data, state: row.data.state === 'queued' ? 'cancelled' : 'unknown', error: 'Execution stopped before a confirmed result' }, row.revision);
        if (row.data.state === 'queued') throw new DomainError('device_not_dispatched', 'Device operation stopped before dispatch', 409);
      }
      throw error;
    }
  }

  private hydrateEphemeralPayload(job: DeviceJob, ownerId: string): DeviceJob | undefined {
    const reference = job.input.ephemeralPayloadRef;
    if (reference === undefined) return job;
    if (typeof reference !== 'string' || !this.ephemeralPayloads) return undefined;
    const payload = this.ephemeralPayloads.consumePayload(ownerId, job.taskId, reference);
    if (!payload) return undefined;
    const hydrated = structuredClone(job);
    delete hydrated.input.ephemeralPayloadRef;
    if (!hydrateMessages(hydrated.input.messages, payload)) return undefined;
    return hydrated;
  }

  private validateInlineArtifact(artifact: InlineDeviceArtifact, job: DeviceJob): Uint8Array {
    const workspaceExport = job.toolName === 'workspace.export';
    if (!artifact.name || artifact.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(artifact.name)
      || (workspaceExport ? workspaceExportMimeType(artifact.name) !== artifact.mimeType : artifact.mimeType !== 'image/png')) {
      throw new DomainError('invalid_device_artifact', 'Inline artifact metadata is invalid');
    }
    if (workspaceExport && (typeof job.input.path !== 'string' || path.basename(job.input.path) !== artifact.name)) {
      throw new DomainError('invalid_device_artifact', 'Inline artifact does not match the selected workspace file');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.bytesBase64)) {
      throw new DomainError('invalid_device_artifact', 'Inline artifact encoding is invalid');
    }
    const bytes = Buffer.from(artifact.bytesBase64, 'base64');
    if (workspaceExport) {
      if (bytes.byteLength > MAX_WORKSPACE_EXPORT_BYTES) throw new DomainError('attachment_too_large', 'Workspace export exceeds 6 MB', 413);
      validateWorkspaceExport(bytes, artifact.name, artifact.mimeType);
    } else if (bytes.byteLength === 0 || bytes.byteLength > 6 * 1024 * 1024
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new DomainError('invalid_device_artifact', 'Inline screenshot is empty, oversized, or not a PNG', 413);
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifact.sha256) throw new DomainError('storage_integrity', 'Inline artifact checksum does not match', 409);
    const capturedAt = Date.parse(artifact.capturedAt);
    const dispatchedAt = Date.parse(job.dispatchedAt);
    const expiresAt = Date.parse(job.expiresAt);
    if (!Number.isFinite(capturedAt) || !Number.isFinite(dispatchedAt) || capturedAt < dispatchedAt - 300_000
      || capturedAt > this.now() + 30_000 || capturedAt > expiresAt + 30_000) {
      throw new DomainError('invalid_device_artifact', 'Inline artifact timestamp is outside the job window');
    }
    return bytes;
  }
}

function hydrateMessages(value: unknown, payload: EphemeralModelPayload): boolean {
  if (!Array.isArray(value)) return false;
  for (const attachment of payload.attachments) {
    const message = value[attachment.messageIndex];
    if (!isRecord(message)) return false;
    const current = message.attachments;
    if (current !== undefined && !Array.isArray(current)) return false;
    const attachments = current ?? [];
    attachments.splice(attachment.attachmentIndex, 0, {
      mimeType: attachment.mimeType,
      data: attachment.data,
      ephemeral: true,
    });
    message.attachments = attachments;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerDeviceRoutes(app: FastifyInstance, devices: DeviceService, principal: (request: FastifyRequest) => Principal) {
  const authenticate = (request: FastifyRequest) => devices.authenticate(request.headers.authorization, deviceParams.parse(request.params).id);
  app.get('/v1/devices', async (request) => ({ data: await devices.list(principal(request).id) }));
  app.post('/v1/pairings', async (request, reply) => {
    const body = z.object({ capabilities: z.array(z.string().min(1).max(100)).max(40), workspaceIds: z.array(z.string().min(1).max(200)).max(40).default([]) }).strict().parse(request.body);
    return reply.code(201).send(await devices.createPairing(principal(request), body.capabilities, body.workspaceIds));
  });
  app.post('/v1/devices/pair', { config: { public: true } }, async (request, reply) => {
    const body = z.object({ code: z.string().min(20).max(100), name: z.string().min(1).max(200), capabilities: z.array(z.string().min(1).max(100)).max(40) }).strict().parse(request.body);
    return reply.code(201).send(await devices.pair(body));
  });
  app.post('/v1/devices/:id/heartbeat', { config: { deviceAuth: true } }, async (request) => {
    const body = z.object({ capabilities: z.array(z.string().max(100)).max(40).optional() }).strict().parse(request.body);
    return devices.heartbeat(await authenticate(request), body.capabilities);
  });
  app.get('/v1/devices/:id/jobs', { config: { deviceAuth: true } }, async (request) => devices.poll(await authenticate(request)));
  app.post('/v1/devices/:id/jobs/:jobId/write-lease', { config: { deviceAuth: true } }, async (request) => {
    const { jobId } = z.object({ jobId: z.string().min(1).max(200) }).parse(request.params);
    return devices.validateWriteLease(await authenticate(request), jobId);
  });
  app.post('/v1/devices/:id/jobs/:jobId/result', { bodyLimit: 12 * 1024 * 1024, config: { deviceAuth: true } }, async (request, reply) => {
    const { jobId } = z.object({ jobId: z.string().min(1).max(200) }).parse(request.params);
    const inlineArtifact = z.object({
      name: z.string().min(1).max(255), mimeType: z.enum(WORKSPACE_EXPORT_MIME_TYPES), bytesBase64: z.string().min(4).max(8 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.iso.datetime(),
    }).strict();
    const body = z.object({
      status: z.enum(['confirmed', 'failed', 'unknown', 'cancelled']),
      result: z.object({ content: z.string().max(500000), isError: z.boolean().optional() }).strict().optional(),
      inlineArtifacts: z.array(inlineArtifact).max(2).optional(), error: z.string().max(2000).optional(),
    }).strict().parse(request.body);
    await devices.submit(await authenticate(request), jobId, body); return reply.code(204).send();
  });
  app.post('/v1/devices/:id/control', async (request) => {
    const owner = principal(request); requireScope(owner, 'device:write');
    const body = z.object({ action: z.enum(['pause', 'resume', 'revoke']) }).strict().parse(request.body);
    return { data: await devices.control(owner.id, deviceParams.parse(request.params).id, body.action) };
  });
  app.put('/v1/devices/:id/workspaces', async (request) => {
    const body = z.object({ workspaceIds: z.array(z.string().min(1).max(200)).max(40) }).strict().parse(request.body);
    return { data: await devices.grant(principal(request), deviceParams.parse(request.params).id, body.workspaceIds) };
  });
}
