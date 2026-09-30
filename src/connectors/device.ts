import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DomainError, type Principal, type ToolDefinition, type ToolResult, type Workspace } from '../contracts.js';
import type { WorkspaceWriteLease } from '../workspace-write-lease.js';
import {
  MAX_WORKSPACE_EXPORT_BYTES,
  readStableWorkspaceExport,
  type WorkspaceExportMimeType,
  validateWorkspaceExport,
  workspaceExportMimeType,
} from '../tools/workspace-export.js';

export interface DevicePairRequest {
  code: string;
  name: string;
  capabilities: string[];
}

export interface DevicePairResponse {
  deviceId: string;
  token: string;
  ownerId: string;
}

export interface DeviceJob {
  id: string;
  deviceId: string;
  principal: Principal;
  taskId: string;
  workspace?: Workspace;
  toolName: string;
  input: Record<string, unknown>;
  requiredCapabilities: string[];
  expiresAt: string;
  dispatchedAt: string;
  workspaceWriteLease?: WorkspaceWriteLease;
}

export interface DeviceJobResult {
  status: 'confirmed' | 'failed' | 'unknown' | 'cancelled';
  result?: ToolResult;
  error?: string;
  inlineArtifacts?: InlineDeviceArtifact[];
}

export interface InlineDeviceArtifact {
  name: string;
  mimeType: WorkspaceExportMimeType;
  bytesBase64: string;
  sha256: string;
  capturedAt: string;
}

export interface DeviceTransport {
  pair(request: DevicePairRequest): Promise<DevicePairResponse>;
  heartbeat(deviceId: string, capabilities?: string[]): Promise<{ online: true; serverTime: string }>;
  poll(deviceId: string): Promise<{ jobs: DeviceJob[] }>;
  submitResult(deviceId: string, jobId: string, result: DeviceJobResult): Promise<void>;
  validateWriteLease?(deviceId: string, jobId: string): Promise<{ valid: boolean }>;
}

export interface HttpDeviceTransportOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpDeviceTransport implements DeviceTransport {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private token?: string;

  constructor(options: HttpDeviceTransportOptions) {
    this.baseUrl = new URL(options.baseUrl);
    const loopback = this.baseUrl.hostname === 'localhost'
      || this.baseUrl.hostname === '127.0.0.1'
      || this.baseUrl.hostname === '[::1]';
    if (this.baseUrl.protocol !== 'https:' && !(this.baseUrl.protocol === 'http:' && loopback)) {
      throw new DomainError('insecure_device_transport', 'Device transport requires HTTPS except on loopback', 400);
    }
    this.fetchImplementation = options.fetch ?? fetch;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(method: string, pathname: string, body?: unknown, authenticated = true): Promise<T> {
    if (authenticated && !this.token) throw new DomainError('device_not_paired', 'Device bearer token is not configured', 401);
    const response = await this.fetchImplementation(new URL(pathname, this.baseUrl), {
      method,
      headers: {
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new DomainError('device_transport_error', `Device service returned HTTP ${response.status}`, response.status);
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
    return await response.json() as T;
  }

  async pair(request: DevicePairRequest): Promise<DevicePairResponse> {
    const response = await this.request<DevicePairResponse>('POST', '/v1/devices/pair', request, false);
    if (typeof response.token !== 'string' || response.token.length < 32) throw new DomainError('invalid_device_token', 'Device token is too short', 502);
    this.token = response.token;
    return response;
  }

  async heartbeat(deviceId: string, capabilities?: string[]): Promise<{ online: true; serverTime: string }> {
    return this.request('POST', `/v1/devices/${encodeURIComponent(deviceId)}/heartbeat`, capabilities ? { capabilities } : {});
  }

  async poll(deviceId: string): Promise<{ jobs: DeviceJob[] }> {
    return this.request('GET', `/v1/devices/${encodeURIComponent(deviceId)}/jobs`);
  }

  async submitResult(deviceId: string, jobId: string, result: DeviceJobResult): Promise<void> {
    await this.request('POST', `/v1/devices/${encodeURIComponent(deviceId)}/jobs/${encodeURIComponent(jobId)}/result`, result);
  }

  async validateWriteLease(deviceId: string, jobId: string): Promise<{ valid: boolean }> {
    return this.request('POST', `/v1/devices/${encodeURIComponent(deviceId)}/jobs/${encodeURIComponent(jobId)}/write-lease`, {});
  }
}

export interface DeviceConnectorOptions {
  deviceId: string;
  ownerId?: string;
  transport: DeviceTransport;
  capabilities: string[];
  workspaceIds?: string[];
  workspaces?: ReadonlyMap<string, Workspace> | Record<string, Workspace>;
  tools: ToolDefinition[];
  now?: () => Date;
  journalPath?: string;
}

export interface DevicePollResult {
  online: boolean;
  received: number;
  executed: number;
  rejected: number;
}

interface DeviceJournalEntry {
  state: 'started' | 'completed';
  sideEffect: ToolDefinition['sideEffect'];
  result?: DeviceJobResult;
  submitted: boolean;
  updatedAt: string;
  cleanupPaths?: string[];
}

interface DeviceJournal {
  version: 1;
  jobs: Record<string, DeviceJournalEntry>;
}

function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes.some((grant) => grant === '*'
    || grant === 'kiancode:*'
    || grant === scope
    || grant === `kiancode:${scope}`
    || grant === `${scope.split(':')[0]}:*`);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function delegatedWorkspaceAction(capability: string): 'read' | 'write' | 'export' {
  if (capability === 'workspace:export') return 'export';
  return capability.endsWith('write') ? 'write' : 'read';
}

export class DeviceConnector {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => Date;
  private readonly localWorkspaces?: Map<string, Workspace>;
  private journal: DeviceJournal = { version: 1, jobs: {} };
  private journalLoaded = false;

  constructor(private readonly options: DeviceConnectorOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.now = options.now ?? (() => new Date());
    if (options.workspaces) {
      this.localWorkspaces = options.workspaces instanceof Map
        ? new Map(options.workspaces)
        : new Map(Object.entries(options.workspaces));
    }
  }

  cancel(jobId: string): boolean {
    const controller = this.active.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async loadJournal(): Promise<void> {
    if (this.journalLoaded) return;
    if (!this.options.journalPath) {
      this.journalLoaded = true;
      return;
    }
    try {
      const journal = JSON.parse(await readFile(this.options.journalPath, 'utf8')) as DeviceJournal;
      if (journal.version !== 1 || !journal.jobs || typeof journal.jobs !== 'object') throw new Error('invalid journal');
      this.journal = journal;
      this.journalLoaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.journalLoaded = true;
        return;
      }
      throw new DomainError('invalid_device_journal', 'Device result journal is invalid');
    }
  }

  private async saveJournal(): Promise<void> {
    if (!this.options.journalPath) return;
    await mkdir(path.dirname(this.options.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.journalPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.journal)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.options.journalPath);
  }

  private workspaceForJob(job: DeviceJob): { workspace?: Workspace; error?: string } {
    if (job.deviceId !== this.options.deviceId) {
      return { error: 'Job targets another device' };
    }
    if (!job.workspace) return {};
    if (job.workspace.deviceId !== this.options.deviceId) return { error: 'Workspace targets another device' };
    if (this.localWorkspaces) {
      const local = this.localWorkspaces.get(job.workspace.id);
      if (!local) return { error: 'Workspace is not configured on this device' };
      if (local.deviceId !== this.options.deviceId) return { error: 'Local workspace targets another device' };
      return { workspace: local };
    }
    if (!(this.options.workspaceIds ?? []).includes(job.workspace.id)) return { error: 'Workspace is not configured on this device' };
    return { workspace: job.workspace };
  }

  private authorizationError(job: DeviceJob, workspace: Workspace | undefined, tool: ToolDefinition | undefined): string | undefined {
    if (!tool) return 'Tool is not available on this device';
    if (this.options.ownerId && job.principal.id !== this.options.ownerId) return 'Job principal does not own this device';
    if (tool.requiresWorkspace === true && !workspace) return 'Tool requires a configured workspace';
    const required = new Set([...job.requiredCapabilities, ...tool.requiredCapabilities]);
    for (const capability of required) {
      if (!this.options.capabilities.includes(capability)) return `Device lacks ${capability}`;
      if (!hasScope(job.principal, capability)) return `Principal lacks ${capability}`;
      if (workspace && !workspace.capabilities.includes(capability)) return `Workspace lacks ${capability}`;
    }
    if (!workspace) return undefined;
    const workspaceScope = `workspace:${workspace.id}`;
    if (workspace.ownerId !== job.principal.id && !hasScope(job.principal, workspaceScope)) {
      for (const capability of required) {
        if (!hasScope(job.principal, `${workspaceScope}:${delegatedWorkspaceAction(capability)}`)) {
          return 'Principal is not authorized for this workspace';
        }
      }
    }
    return undefined;
  }

  private async markStarted(jobId: string, sideEffect: ToolDefinition['sideEffect']): Promise<void> {
    this.journal.jobs[jobId] = { state: 'started', sideEffect, submitted: false, updatedAt: this.now().toISOString() };
    await this.saveJournal();
  }

  private async markCompleted(jobId: string, sideEffect: ToolDefinition['sideEffect'], result: DeviceJobResult, cleanupPaths?: string[]): Promise<void> {
    this.journal.jobs[jobId] = { state: 'completed', sideEffect, result, submitted: false, updatedAt: this.now().toISOString(), ...(cleanupPaths?.length ? { cleanupPaths } : {}) };
    await this.saveJournal();
  }

  private async submitRecorded(jobId: string): Promise<boolean> {
    const entry = this.journal.jobs[jobId];
    if (!entry || entry.state !== 'completed' || !entry.result || entry.submitted) return true;
    try {
      await this.options.transport.submitResult(this.options.deviceId, jobId, entry.result);
      await Promise.all((entry.cleanupPaths ?? []).map((file) => unlink(file).catch(() => undefined)));
      delete entry.cleanupPaths;
      delete entry.result;
      entry.submitted = true;
      entry.updatedAt = this.now().toISOString();
      await this.saveJournal();
      return true;
    } catch {
      return false;
    }
  }

  private async flushJournal(): Promise<boolean> {
    let delivered = true;
    for (const [jobId, entry] of Object.entries(this.journal.jobs)) {
      if (entry.state === 'started') {
        entry.state = 'completed';
        entry.result = {
          status: entry.sideEffect === 'read' ? 'failed' : 'unknown',
          error: entry.sideEffect === 'read'
            ? 'Previous device process stopped before the read completed'
            : 'Previous device process stopped before the side-effect outcome was confirmed',
        };
        entry.submitted = false;
        entry.updatedAt = this.now().toISOString();
        await this.saveJournal();
      }
      if (!await this.submitRecorded(jobId)) delivered = false;
    }
    return delivered;
  }

  async pollOnce(): Promise<DevicePollResult> {
    await this.loadJournal();
    let response: { jobs: DeviceJob[] };
    try {
      await this.options.transport.heartbeat(this.options.deviceId, this.options.capabilities);
      await this.flushJournal();
      response = await this.options.transport.poll(this.options.deviceId);
    } catch {
      return { online: false, received: 0, executed: 0, rejected: 0 };
    }
    let executed = 0;
    let rejected = 0;
    for (const job of response.jobs) {
      if (this.journal.jobs[job.id] || this.active.has(job.id)) continue;
      const expiry = Date.parse(job.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= this.now().getTime()) {
        rejected += 1;
        await this.markCompleted(job.id, 'external', {
          status: 'failed',
          error: 'Job expired before local execution',
        });
        await this.submitRecorded(job.id);
        continue;
      }
      const tool = this.tools.get(job.toolName);
      const local = this.workspaceForJob(job);
      const authorizationError = local.error ?? this.authorizationError(job, local.workspace, tool);
      if (authorizationError || !tool) {
        rejected += 1;
        await this.markCompleted(job.id, tool?.sideEffect ?? 'external', {
          status: 'failed',
          error: authorizationError ?? 'Tool is unavailable',
        });
        await this.submitRecorded(job.id);
        continue;
      }
      if (job.workspaceWriteLease) {
        let valid = false;
        try { valid = Boolean((await this.options.transport.validateWriteLease?.(this.options.deviceId, job.id))?.valid); } catch { /* A writer needs current server confirmation. */ }
        if (!valid) {
          rejected += 1;
          await this.markCompleted(job.id, tool.sideEffect, { status: 'failed', error: 'Workspace writer lease is no longer valid' });
          await this.submitRecorded(job.id);
          continue;
        }
      }
      const controller = new AbortController();
      this.active.set(job.id, controller);
      await this.markStarted(job.id, tool.sideEffect);
      let checking = false;
      const fenceTimer = job.workspaceWriteLease ? setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          if (!(await this.options.transport.validateWriteLease?.(this.options.deviceId, job.id))?.valid) controller.abort();
        } catch { controller.abort(); }
        finally { checking = false; }
      }, 1000) : undefined;
      fenceTimer?.unref();
      try {
        const rawResult = await tool.execute(job.input, {
          principal: job.principal,
          workspace: local.workspace,
          taskId: job.taskId,
          signal: controller.signal,
          workspaceWriteLease: job.workspaceWriteLease,
        });
        const cancelled = controller.signal.aborted;
        const prepared = cancelled
          ? await this.discardLocalArtifacts(job, rawResult)
          : await this.prepareResult(job, local.workspace, rawResult);
        const result = prepared.result;
        const status = cancelled
          ? (tool.sideEffect === 'read' ? 'cancelled' : 'unknown')
          : (result.isError ? 'failed' : 'confirmed');
        await this.markCompleted(job.id, tool.sideEffect, {
          status,
          result,
          ...(prepared.inlineArtifacts.length ? { inlineArtifacts: prepared.inlineArtifacts } : {}),
          ...(cancelled && tool.sideEffect !== 'read' ? { error: 'Cancellation requested; side-effect outcome is unknown' } : {}),
        }, prepared.cleanupPaths);
        await this.submitRecorded(job.id);
        if (!cancelled) executed += 1;
      } catch (error) {
        const status = tool.sideEffect === 'read'
          ? (controller.signal.aborted ? 'cancelled' : 'failed')
          : 'unknown';
        await this.markCompleted(job.id, tool.sideEffect, {
          status,
          error: error instanceof Error ? error.message : 'Unknown tool error',
        });
        await this.submitRecorded(job.id);
      } finally {
        clearInterval(fenceTimer);
        this.active.delete(job.id);
      }
    }
    return { online: true, received: response.jobs.length, executed, rejected };
  }

  private async prepareResult(job: DeviceJob, workspace: Workspace | undefined, result: ToolResult): Promise<{ result: ToolResult; inlineArtifacts: InlineDeviceArtifact[]; cleanupPaths: string[] }> {
    if (!result.artifacts?.length) return { result, inlineArtifacts: [], cleanupPaths: [] };
    if (result.artifacts.length !== 1 || result.isError) {
      throw new DomainError('invalid_device_artifact', 'A successful device artifact tool must return exactly one local artifact');
    }
    const artifact = result.artifacts[0]!;
    if (job.toolName === 'workspace.export') {
      if (!workspace || !job.requiredCapabilities.includes('workspace:export') || artifact.transient !== false
        || !artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        throw new DomainError('invalid_device_artifact', 'Workspace export artifact metadata is invalid');
      }
      const mimeType = workspaceExportMimeType(artifact.name);
      if (!mimeType || artifact.mimeType !== mimeType || !artifact.name || artifact.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(artifact.name)) {
        throw new DomainError('invalid_device_artifact', 'Workspace export name or media type is invalid');
      }
      const requested = job.input.path;
      if (typeof requested !== 'string' || !requested) throw new DomainError('invalid_device_artifact', 'Workspace export path is invalid');
      const root = await realpath(workspace.root);
      const resolved = await realpath(artifact.path);
      const selected = await realpath(path.resolve(root, requested));
      if (!isWithin(root, resolved) || !isWithin(root, selected) || resolved !== selected) {
        throw new DomainError('invalid_device_artifact', 'Workspace export artifact is not the selected workspace file', 403);
      }
      const bytes = await readStableWorkspaceExport(resolved, MAX_WORKSPACE_EXPORT_BYTES, root);
      validateWorkspaceExport(bytes, artifact.name, mimeType);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== artifact.sha256) throw new DomainError('export_conflict', 'Workspace file changed before export submission', 409);
      const { artifacts: _localPaths, artifactIds: _untrustedIds, ...portable } = result;
      return {
        result: portable,
        inlineArtifacts: [{
          name: artifact.name,
          mimeType,
          bytesBase64: bytes.toString('base64'),
          sha256: digest,
          capturedAt: this.now().toISOString(),
        }],
        cleanupPaths: [],
      };
    }
    if (job.toolName !== 'mac.app.screenshot') {
      throw new DomainError('invalid_device_artifact', 'Tool cannot return a local artifact');
    }
    if (!artifact.transient || !artifact.name || artifact.name.length > 255 || /[\r\n\0/\\]/.test(artifact.name) || artifact.mimeType !== 'image/png') {
      throw new DomainError('invalid_device_artifact', 'Mac screenshot artifact metadata is invalid');
    }
    const resolved = await realpath(artifact.path);
    const stats = await lstat(resolved);
    if (!stats.isFile() || stats.size <= 0 || stats.size > 6 * 1024 * 1024) {
      throw new DomainError('invalid_device_artifact', 'Mac screenshot must be a regular PNG no larger than 6 MB', 413);
    }
    const bytes = await readFile(resolved);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new DomainError('invalid_device_artifact', 'Mac screenshot is not a PNG');
    }
    const { artifacts: _localPaths, artifactIds: _untrustedIds, ...portable } = result;
    return {
      result: portable,
      inlineArtifacts: [{
        name: artifact.name,
        mimeType: 'image/png',
        bytesBase64: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        capturedAt: this.now().toISOString(),
      }],
      cleanupPaths: [resolved],
    };
  }

  private async discardLocalArtifacts(job: DeviceJob, result: ToolResult): Promise<{ result: ToolResult; inlineArtifacts: InlineDeviceArtifact[]; cleanupPaths: string[] }> {
    if (job.toolName !== 'workspace.export') {
      for (const artifact of result.artifacts ?? []) {
        if (artifact.transient) await realpath(artifact.path).then((file) => unlink(file)).catch(() => undefined);
      }
    }
    const { artifacts: _localPaths, artifactIds: _untrustedIds, ...portable } = result;
    return { result: portable, inlineArtifacts: [], cleanupPaths: [] };
  }
}
