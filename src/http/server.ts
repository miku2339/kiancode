import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { createHash } from 'node:crypto';
import { z, ZodError } from 'zod';
import { bearer, type Authenticator, requireOwner, requireScope, tokenHash } from '../auth.js';
import { DomainError, type Principal, type ToolDefinition, type Workspace } from '../contracts.js';
import type { Conversation, Message, Memory, Task } from '../domain.js';
import type { Entity, Store } from '../storage/store.js';
import { orderMessages, TaskService, type TaskRunner } from '../tasks.js';
import { DeviceService, registerDeviceRoutes } from '../devices.js';
import { ArtifactService, registerArtifactRoutes } from '../artifacts.js';
import type { AccessService } from '../access.js';
import { DeviceConnectionRegistry, registerDeviceSocket } from './device-socket.js';
import { pluginContentSchema, type PluginService } from '../plugins.js';
import type { OutageMessage, OutageRunResult, OutageService } from '../outage/index.js';
import type { AgentCoordinator } from '../agents/index.js';
import { NotificationService } from '../notifications.js';
import { registerNotificationRoutes } from './notifications-http.js';
import type { ModelManagement } from '../model-management.js';
import { registerModelManagementRoutes } from './model-management.js';
import type { MaintenanceService } from '../maintenance.js';
import { registerMaintenanceRoutes } from './maintenance-http.js';
import { AutomationDispatcher, EventTriggerService } from '../event-triggers.js';
import { SchedulerService } from '../scheduler.js';
import { registerAutomationRoutes } from './event-triggers-http.js';
import { listMemoryRows } from '../memory-query.js';
import { taskPage, taskQuerySchema } from './task-query.js';
import { WorkspaceWriteLeaseService } from '../workspace-write-lease.js';
import { MemoryConflictService } from '../memory-conflicts.js';

const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(64000);
const conversationSchema = z.object({
  title: z.string().trim().min(1).max(200).default('新對話'),
  scope: z.enum(['private', 'group']).default('private'),
  modelPolicy: z.enum(['cloud', 'local', 'auto']).default('cloud'),
  strategy: z.enum(['auto', 'single', 'experts', 'moa']).default('auto'),
  mode: z.enum(['ask', 'plan', 'act']).default('ask'),
  modelId: id.optional(), workspaceId: id.optional(), agentId: id.optional(), archived: z.boolean().default(false),
}).strict();
const conversationCreateSchema = conversationSchema.extend({ requestId: id.optional() });
const memorySchema = z.object({
  type: z.enum(['persona', 'preference', 'episode', 'project', 'agent', 'document']), text,
  scope: z.enum(['private', 'group', 'workspace', 'agent']), scopeId: id.optional(),
  source: z.string().min(1).max(2048), validFrom: z.iso.datetime().optional(), validTo: z.iso.datetime().optional(), replacesId: id.optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((value) => value.scope === 'private' || Boolean(value.scopeId), 'Scoped memory requires scopeId');
const agentSchema = z.object({
  name: z.string().min(1).max(100), systemPrompt: text,
  strategy: z.enum(['auto', 'single', 'experts', 'moa']).default('auto'),
  modelPolicy: z.enum(['cloud', 'local', 'auto']).default('auto'), modelId: id.optional(),
  experts: z.array(z.object({ name: z.string().min(1).max(100), instruction: text }).strict()).max(8).default([]),
  candidateCount: z.number().int().min(1).max(3).default(3),
}).strict();
export interface ServerOptions {
  store: Store;
  authenticate: Authenticator;
  runner: TaskRunner;
  models?: Array<{ id: string; locality: string; capabilities: string[]; enabled?: boolean }>;
  logger?: boolean;
  artifacts?: ArtifactService;
  tools?: ToolDefinition[];
  access?: AccessService;
  plugins?: PluginService;
  outage?: OutageService;
  coordinator?: AgentCoordinator;
  devices?: DeviceService;
  notifications?: NotificationService;
  modelManagement?: ModelManagement;
  maintenance?: MaintenanceService;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  automations?: {
    eventTriggersEnabled: boolean;
    schedulerEnabled: boolean;
  };
}

export async function createServer(options: ServerOptions) {
  const { store } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024, requestTimeout: 30000 });
  await app.register(websocket, { options: { maxPayload: 12 * 1024 * 1024 } });
  const notifications = options.notifications ?? new NotificationService(store);
  const reauthorize = options.reauthorize ?? (options.access ? async (identity: Principal) => {
    if (!await options.access!.validateDelegation(identity)) throw new DomainError('grant_revoked', 'Task authorization has expired or been revoked', 403);
    return options.access!.authorize(identity);
  } : undefined);
  const tasks = new TaskService(store, options.runner, {
    onError: (error) => app.log.error(error),
    notifications,
    ...(reauthorize ? { reauthorize } : {}),
  });
  const devices = options.devices ?? new DeviceService(store);
  const dispatcher = new AutomationDispatcher(store, tasks);
  const deviceConnections = new DeviceConnectionRegistry();
  const eventTriggers = new EventTriggerService(store, dispatcher, {
    enabled: options.automations?.eventTriggersEnabled === true,
    ...(reauthorize ? { reauthorize } : {}),
    validateDeviceConnection: (edge) => deviceConnections.validate(edge),
  });
  const scheduler = new SchedulerService(store, dispatcher, {
    enabled: options.automations?.schedulerEnabled === true,
    ...(reauthorize ? { reauthorize } : {}),
  });
  const principals = new WeakMap<FastifyRequest, Principal>();
  const outageRequests = new WeakSet<FastifyRequest>();
  let degraded = false;
  const principal = (request: FastifyRequest): Principal => {
    const value = principals.get(request);
    if (!value) throw new DomainError('unauthorized', 'Sign in to continue', 401);
    return value;
  };
  const params = (request: FastifyRequest) => z.object({ id }).parse(request.params);
  const existing = async <T>(request: FastifyRequest, kind: string) => {
    const row = await store.get<T>(kind, params(request).id, principal(request).id);
    if (!row) throw new DomainError('not_found', 'Resource not found', 404);
    return row;
  };
  const assertReference = async (ownerId: string, kind: string, reference?: string) => {
    if (reference && !await store.get(kind, reference, ownerId)) throw new DomainError('not_found', `${kind} not found`, 404);
  };
  const requestToken = (request: FastifyRequest): string => bearer(request.headers.authorization);
  const isOutageRequest = (request: FastifyRequest): boolean => outageRequests.has(request);
  const unavailable = (error: unknown): boolean => !(error instanceof DomainError)
    || ['identity_unavailable', 'storage_unavailable'].includes(error.code);
  const outageTask = (result: OutageRunResult) => ({
    id: result.id,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    data: {
      conversationId: result.conversationId,
      ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
      state: result.state,
      degraded: true,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    },
    degraded: true,
  });
  const cacheOutageContext = async (
    request: FastifyRequest,
    owner: Principal,
    conversation: Entity<Conversation>,
  ): Promise<void> => {
    if (!options.outage || conversation.data.scope !== 'private' || conversation.data.internalOperation
      || !owner.expiresAt || Date.parse(owner.expiresAt) <= Date.now()) return;
    try {
      const history = orderMessages((await store.scan<Message>('message', owner.id))
        .filter((message) => message.data.conversationId === conversation.id));
      const workspace = conversation.data.workspaceId
        ? await store.get<Workspace>('workspace', conversation.data.workspaceId, owner.id)
        : undefined;
      await options.outage.cacheContext({
        principal: owner,
        tokenHash: tokenHash(requestToken(request)),
        sessionExpiresAt: owner.expiresAt,
        conversation: {
          id: conversation.id,
          ownerId: owner.id,
          title: conversation.data.title,
          scope: 'private',
          modelPolicy: conversation.data.modelPolicy,
          strategy: conversation.data.strategy,
          mode: conversation.data.mode,
          ...(conversation.data.modelId ? { modelId: conversation.data.modelId } : {}),
          ...(conversation.data.workspaceId ? { workspaceId: conversation.data.workspaceId } : {}),
          ...(conversation.data.agentId ? { agentId: conversation.data.agentId } : {}),
          privacy: workspace?.data.allowCloud === false ? 'private' : 'standard',
          ...(workspace ? { workspaceAllowCloud: workspace.data.allowCloud } : {}),
          archived: false,
        },
        history: history.slice(-60).map((message) => ({
          id: message.id,
          role: message.data.role,
          content: message.data.content,
          createdAt: message.createdAt,
          ...(message.data.sequence !== undefined ? { sequence: message.data.sequence } : {}),
        })),
      });
    } catch (error) {
      app.log.error(error);
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') } });
    if ((error as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: { code: 'invalid_input', message: 'Invalid request' } });
    app.log.error(error);
    return reply.code(503).send({ error: { code: 'service_unavailable', message: 'Service is temporarily unavailable' } });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (request.routeOptions.config.public || request.routeOptions.config.deviceAuth) return;
    let owner: Principal;
    try {
      owner = await options.authenticate(request.headers.authorization);
    } catch (error) {
      if (options.outage && request.routeOptions.config.outageFallback && unavailable(error)) {
        requestToken(request);
        outageRequests.add(request);
        degraded = true;
        return;
      }
      throw error;
    }
    principals.set(request, owner);
    const route = request.routeOptions.url ?? '';
    const resource = route.split('/')[2];
    const resources: Record<string, string> = { conversations: 'chat', tasks: 'task', agents: 'agent', workspaces: 'workspace', memories: 'memory', schedules: 'schedule', 'schedule-drafts': 'schedule', 'event-triggers': 'schedule', devices: 'device', pairings: 'device', models: 'model', providers: 'model', notifications: 'notification', maintenance: 'maintenance' };
    if (resource && resources[resource] && !route.endsWith('/operations')) requireScope(owner, `${resources[resource]}:${request.method === 'GET' ? 'read' : 'write'}`);
  });
  app.addHook('onResponse', async (request, reply) => {
    const actor = principals.get(request);
    const route = request.routeOptions.url;
    if (!options.maintenance || !actor || !route || !route.startsWith('/v1/')
      || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    try {
      await options.maintenance.record(actor, {
        method: request.method,
        route,
        statusCode: reply.statusCode,
        requestId: request.id,
      });
    } catch {
      app.log.warn('Maintenance activity audit is temporarily unavailable.');
    }
  });
  app.get('/health/live', { config: { public: true } }, async () => ({ status: 'ok', degraded }));
  app.get('/v1/health', { config: { outageFallback: true } }, async (request) => {
    if (isOutageRequest(request)) return { status: 'degraded', degraded: true, storage: 'unavailable', outage: await options.outage!.stats() };
    try {
      await store.scan('health');
      const outageStats = await options.outage?.stats();
      degraded = Boolean(outageStats?.unsyncedRecords);
      const owner = principal(request);
      const models = options.modelManagement ? await options.modelManagement.models(owner.id) : options.models ?? [];
      return { status: degraded ? 'degraded' : 'ok', degraded, storage: 'connected', ...(outageStats ? { outage: outageStats } : {}), models: models.length, devices: (await devices.list(owner.id)).length };
    } catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      return { status: 'degraded', degraded: true, storage: 'unavailable', outage: await options.outage.stats() };
    }
  });
  // Readiness is based on the durable store, independently of the process liveness probe.
  app.get('/health/ready', { config: { public: true } }, async () => {
    try {
      await store.scan('health');
      const outageStats = await options.outage?.stats();
      degraded = Boolean(outageStats?.unsyncedRecords);
      return { status: degraded ? 'degraded' : 'ready', degraded, ...(outageStats ? { outage: outageStats } : {}) };
    } catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      return { status: 'degraded', degraded: true, storage: 'unavailable', outage: await options.outage.stats() };
    }
  });
  app.get('/v1/session', async (request) => ({ data: principal(request) }));
  app.put('/v1/access/:id', async (request) => {
    if (!options.access) throw new DomainError('unavailable', 'Access management is not configured', 503);
    const body = z.object({ scopes: z.array(z.string().min(1).max(100)).max(100), enabled: z.boolean() }).strict().parse(request.body);
    return { data: await options.access.grant(principal(request), params(request).id, body) };
  });
  app.get('/v1/models', async (request) => ({
    data: options.modelManagement
      ? await options.modelManagement.models(principal(request).id)
      : options.models ?? [],
  }));
  if (options.modelManagement) registerModelManagementRoutes(app, options.modelManagement, principal);
  if (options.maintenance) registerMaintenanceRoutes(app, options.maintenance, principal);
  registerAutomationRoutes(app, { eventTriggers, scheduler }, principal);
  app.get('/v1/plugins', async (request) => { requireScope(principal(request), 'plugin:use'); return { data: await store.scan('plugin', principal(request).id) }; });
  app.get('/v1/plugins/:id/versions', async (request) => {
    const owner = principal(request); requireScope(owner, 'plugin:use');
    if (!options.plugins) throw new DomainError('unavailable', 'Plugin management is not configured', 503);
    await existing(request, 'plugin');
    return { data: await options.plugins.listVersions(owner, params(request).id) };
  });
  app.post('/v1/plugins/:id/versions', async (request, reply) => {
    if (!options.plugins) throw new DomainError('unavailable', 'Plugin management is not configured', 503);
    const body = z.object({ name: z.string().min(1).max(200), content: pluginContentSchema }).strict().parse(request.body);
    return reply.code(201).send({ data: await options.plugins.install(principal(request), params(request).id, body.name, body.content) });
  });
  app.patch('/v1/plugins/:id', async (request) => {
    if (!options.plugins) throw new DomainError('unavailable', 'Plugin management is not configured', 503);
    const body = z.object({ revision: z.number().int().positive(), enabled: z.boolean().optional(), version: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(request.body);
    return { data: await options.plugins.configure(principal(request), params(request).id, body) };
  });

  app.get('/v1/conversations', async (request) => {
    requireScope(principal(request), 'chat:read');
    const query = z.object({ q: z.string().max(200).optional(), archived: z.enum(['true', 'false']).optional() }).parse(request.query);
    let rows = await store.scan<Conversation>('conversation', principal(request).id);
    rows = rows.filter((row) => !row.data.internalOperation && !('automationSnapshot' in row.data));
    if (query.q) rows = rows.filter((row) => row.data.title.toLowerCase().includes(query.q!.toLowerCase()));
    if (query.archived) rows = rows.filter((row) => row.data.archived === (query.archived === 'true'));
    return { data: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  });
  app.post('/v1/conversations', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'chat:write');
    const { requestId, ...data } = conversationCreateSchema.parse(request.body);
    await assertReference(owner.id, 'workspace', data.workspaceId);
    await assertReference(owner.id, 'agent', data.agentId);
    if (!requestId) return reply.code(201).send({ data: await store.create('conversation', owner.id, data) });
    const conversationId = createHash('sha256').update(`${owner.id}\0${requestId}`).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    type ConversationRequest = { conversationId: string; fingerprint: string };
    let mapping = await store.get<ConversationRequest>('conversation_request', conversationId, owner.id);
    if (!mapping) {
      try {
        mapping = await store.create('conversation_request', owner.id, { conversationId, fingerprint }, conversationId);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
        mapping = await store.get<ConversationRequest>('conversation_request', conversationId, owner.id);
      }
    }
    if (!mapping || mapping.data.fingerprint !== fingerprint) {
      throw new DomainError('idempotency_conflict', 'Request ID already belongs to different conversation input.', 409);
    }
    let conversation = await store.get<Conversation>('conversation', conversationId, owner.id);
    if (!conversation) {
      try {
        conversation = await store.create('conversation', owner.id, data, conversationId);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
        conversation = await store.get<Conversation>('conversation', conversationId, owner.id);
      }
    }
    if (!conversation) throw new DomainError('storage_unavailable', 'Conversation creation was not confirmed.', 503);
    return reply.code(201).send({ data: conversation });
  });
  app.get('/v1/conversations/:id', { config: { outageFallback: true } }, async (request) => {
    if (isOutageRequest(request)) {
      const result = await options.outage!.conversation(requestToken(request), params(request).id);
      return { data: { id: result.conversation.id, data: result.conversation, degraded: true } };
    }
    try {
      const row = await existing<Conversation>(request, 'conversation');
      await cacheOutageContext(request, principal(request), row);
      return { data: row };
    } catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      const result = await options.outage.conversation(requestToken(request), params(request).id);
      return { data: { id: result.conversation.id, data: result.conversation, degraded: true } };
    }
  });
  app.patch('/v1/conversations/:id', async (request) => {
    const owner = principal(request); requireScope(owner, 'chat:write');
    const row = await existing<Conversation>(request, 'conversation');
    const body = z.object({ revision: z.number().int().positive(), changes: conversationSchema.partial() }).strict().parse(request.body);
    const data = conversationSchema.parse({ ...row.data, ...body.changes });
    await assertReference(owner.id, 'workspace', data.workspaceId);
    await assertReference(owner.id, 'agent', data.agentId);
    return { data: await store.put('conversation', row.id, owner.id, data, body.revision) };
  });
  app.get('/v1/conversations/:id/messages', { config: { outageFallback: true } }, async (request) => {
    if (isOutageRequest(request)) return { data: outageMessages(await options.outage!.messages(requestToken(request), params(request).id), params(request).id) };
    requireScope(principal(request), 'chat:read');
    try {
      const row = await existing<Conversation>(request, 'conversation');
      const messages = orderMessages((await store.scan<Message>('message', row.ownerId)).filter((message) => message.data.conversationId === row.id));
      await cacheOutageContext(request, principal(request), row);
      return { data: messages };
    } catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      return { data: outageMessages(await options.outage.messages(requestToken(request), params(request).id), params(request).id) };
    }
  });
  app.post('/v1/conversations/:id/messages', { config: { outageFallback: true } }, async (request, reply) => {
    const body = z.object({ content: text, requestId: z.string().min(1).max(200).optional(), attachmentIds: z.array(id).max(10).default([]) }).strict().parse(request.body);
    const runOutage = async () => {
      if (!options.outage) throw new DomainError('service_unavailable', 'Primary storage is unavailable.', 503);
      if (body.attachmentIds.length) throw new DomainError('outage_attachments_unavailable', 'Attachments are unavailable during NAS outage mode.', 503);
      const result = await options.outage.run({
        token: requestToken(request),
        conversationId: params(request).id,
        prompt: body.content,
        ...(body.requestId ? { requestId: body.requestId } : {}),
      });
      degraded = true;
      return reply.code(202).send({ data: outageTask(result) });
    };
    if (isOutageRequest(request)) return runOutage();
    const owner = principal(request); requireScope(owner, 'chat:write');
    let conversation;
    try {
      conversation = await existing<Conversation>(request, 'conversation');
    } catch (error) {
      if (options.outage && unavailable(error)) return runOutage();
      throw error;
    }
    if (conversation.data.internalOperation) throw new DomainError('operation_conversation', 'Use the workspace operation endpoint', 409);
    await cacheOutageContext(request, owner, conversation);
    return reply.code(202).send({ data: await tasks.enqueue(owner, params(request).id, body.content, body.requestId, body.attachmentIds) });
  });
  app.get('/v1/tasks', { config: { outageFallback: true } }, async (request) => {
    const query = taskQuerySchema.parse(request.query);
    if (isOutageRequest(request)) {
      const rows = await options.outage!.listAll(requestToken(request));
      return taskPage(rows.map(outageTask), query);
    }
    const owner = principal(request);
    requireScope(owner, 'task:read');
    if (query.workspaceId) {
      requireScope(owner, 'workspace:read');
    }
    try {
      if (query.workspaceId && !await store.get('workspace', query.workspaceId, owner.id)) {
        throw new DomainError('not_found', 'Workspace not found', 404);
      }
      const rows = await store.scan<Task>('task', owner.id);
      return taskPage(rows, query);
    }
    catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      const rows = await options.outage.listAll(requestToken(request));
      return taskPage(rows.map(outageTask), query);
    }
  });
  app.get('/v1/tasks/:id', { config: { outageFallback: true } }, async (request) => {
    if (isOutageRequest(request)) return { data: outageTask(await options.outage!.get(requestToken(request), params(request).id)) };
    requireScope(principal(request), 'task:read');
    try { return { data: await existing<Task>(request, 'task') }; }
    catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      return { data: outageTask(await options.outage.get(requestToken(request), params(request).id)) };
    }
  });
  app.post('/v1/tasks/:id/control', async (request) => {
    const owner = principal(request); requireScope(owner, 'task:write');
    const body = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).strict().parse(request.body);
    const taskId = params(request).id;
    const result = await tasks.control(owner.id, taskId, body.action, [], owner);
    await options.coordinator?.propagateControl(owner.id, taskId, body.action, owner);
    return { data: result };
  });
  app.post('/v1/tasks/:id/approve', async (request) => {
    const owner = principal(request); requireScope(owner, 'approval:write');
    const body = z.object({ hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20) }).strict().parse(request.body);
    return { data: await tasks.control(owner.id, params(request).id, 'resume', body.hashes, owner) };
  });
  app.get('/v1/tasks/:id/events', async (request) => {
    requireScope(principal(request), 'task:read');
    const query = z.object({ after: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    return { data: await tasks.events(principal(request).id, params(request).id, query.after) };
  });
  app.get('/v1/tasks/:id/stream', { config: { outageFallback: true } }, async (request, reply) => {
    const taskId = params(request).id;
    if (isOutageRequest(request)) {
      const task = await options.outage!.get(requestToken(request), taskId);
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      reply.raw.end(`id: 1\nevent: degraded\ndata: ${JSON.stringify({ type: task.state, payload: outageTask(task).data, degraded: true })}\n\n`);
      return;
    }
    const owner = principal(request); requireScope(owner, 'task:read');
    try {
      await existing<Task>(request, 'task');
    } catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      const task = await options.outage.get(requestToken(request), taskId);
      degraded = true;
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      reply.raw.end(`id: 1\nevent: degraded\ndata: ${JSON.stringify({ type: task.state, payload: outageTask(task).data, degraded: true })}\n\n`);
      return;
    }
    const query = z.object({ after: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    let sequence = query.after;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    let closed = false;
    reply.raw.on('close', () => { closed = true; });
    const started = Date.now();
    try {
      while (!closed && Date.now() - started < 55000) {
        for (const row of await tasks.events(owner.id, taskId, sequence)) {
          sequence = row.data.sequence;
          reply.raw.write(`id: ${sequence}\nevent: ${row.data.type}\ndata: ${JSON.stringify(row.data)}\n\n`);
        }
        const current = await store.get<Task>('task', taskId, owner.id);
        if (!current || ['completed', 'failed', 'cancelled', 'unknown', 'waiting_for_approval', 'waiting_for_device', 'paused'].includes(current.data.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch { if (!closed) reply.raw.write('event: unavailable\ndata: {}\n\n'); }
    finally { reply.raw.end(); }
  });

  app.get('/v1/memories', async (request) => {
    const owner = principal(request); requireScope(owner, 'memory:read');
    const query = z.object({
      q: z.string().trim().min(1).max(200).optional(),
      scope: z.enum(['private', 'group', 'workspace', 'agent']).optional(),
      scopeId: id.optional(),
      reviewStatus: z.enum(['approved', 'held', 'rejected']).optional(),
      includeExpired: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(1024).optional(),
    }).parse(request.query);
    const requestPage = {
      ownerId: owner.id,
      purpose: 'list' as const,
      q: query.q,
      scope: query.scope,
      scopeId: query.scopeId,
      reviewStatus: query.reviewStatus,
      includeExpired: query.includeExpired === 'true',
      limit: query.limit,
      cursor: query.cursor,
    };
    const page = store.queryMemory
      ? await store.queryMemory(requestPage)
      : listMemoryRows(await store.scan<Memory>('memory', owner.id), requestPage);
    return { data: page.rows, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });
  app.post('/v1/memories/import', async (request) => {
    const owner = principal(request);
    const body = z.object({ entries: z.array(z.object({
      id, memory: memorySchema.safeExtend({ validFrom: z.iso.datetime() }), disposition: z.enum(['approved', 'held']).optional(), reason: z.string().trim().min(1).max(2000).optional(),
    }).strict()).min(1).max(50) }).strict().parse(request.body);
    const conflicts = new MemoryConflictService(store);
    const data = [];
    for (const entry of body.entries) {
      if (entry.memory.scope === 'workspace' || entry.memory.scope === 'agent') await assertReference(owner.id, entry.memory.scope, entry.memory.scopeId);
      data.push(await conflicts.import(owner, entry));
    }
    return { data };
  });
  app.get('/v1/memories/reviews', async (request) => {
    const query = z.object({ id: id.optional(), status: z.enum(['held', 'conflict', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(request.query);
    return { data: await new MemoryConflictService(store).review(principal(request), query) };
  });
  app.post('/v1/memories/reviews/:id/resolve', async (request) => {
    const body = z.object({ expectedRevision: z.number().int().positive(), decision: z.enum(['approve', 'reject', 'keep_existing']), memoryId: id.optional() }).strict().parse(request.body);
    return { data: await new MemoryConflictService(store).resolve(principal(request), params(request).id, body) };
  });
  app.post('/v1/memories', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'memory:write');
    const body = memorySchema.parse(request.body);
    if (body.scope === 'workspace' || body.scope === 'agent') await assertReference(owner.id, body.scope, body.scopeId);
    if (body.replacesId) {
      const previous = await store.get<Memory>('memory', body.replacesId, owner.id);
      if (!previous || previous.data.scope !== body.scope || previous.data.scopeId !== body.scopeId) throw new DomainError('invalid_replacement', 'Memory replacement must have the same owner and scope');
    }
    return reply.code(201).send({ data: await store.create<Memory>('memory', owner.id, { ...body, validFrom: body.validFrom ?? new Date().toISOString() }) });
  });
  app.patch('/v1/memories/:id', async (request) => {
    requireScope(principal(request), 'memory:write');
    const row = await existing<Memory>(request, 'memory');
    const body = z.object({ revision: z.number().int().positive(), text: text.optional(), validTo: z.iso.datetime().optional() }).strict().parse(request.body);
    return { data: await store.put('memory', row.id, row.ownerId, { ...row.data, text: body.text ?? row.data.text, validTo: body.validTo ?? row.data.validTo }, body.revision) };
  });
  app.delete('/v1/memories/:id', async (request, reply) => {
    requireScope(principal(request), 'memory:write'); const row = await existing(request, 'memory');
    const query = z.object({ revision: z.coerce.number().int().positive() }).parse(request.query);
    await store.remove('memory', row.id, row.ownerId, query.revision); return reply.code(204).send();
  });
  app.get('/v1/agents', async (request) => ({
    data: (await store.scan<Record<string, unknown>>('agent', principal(request).id))
      .filter((row) => !('automationSnapshot' in row.data)),
  }));
  app.post('/v1/agents', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'agent:write');
    const data = agentSchema.parse(request.body);
    const models = options.modelManagement ? await options.modelManagement.models(owner.id) : options.models ?? [];
    if (data.modelId && !models.some((model) => model.id === data.modelId && model.enabled !== false)) throw new DomainError('model_not_found', 'Configured model not found', 404);
    return reply.code(201).send({ data: await store.create('agent', owner.id, data) });
  });
  app.put('/v1/agents/:id', async (request) => {
    const owner = principal(request); requireScope(owner, 'agent:write');
    const body = z.object({ revision: z.number().int().positive(), data: agentSchema }).strict().parse(request.body);
    const models = options.modelManagement ? await options.modelManagement.models(owner.id) : options.models ?? [];
    if (body.data.modelId && !models.some((model) => model.id === body.data.modelId && model.enabled !== false)) throw new DomainError('model_not_found', 'Configured model not found', 404);
    return { data: await store.put('agent', params(request).id, owner.id, body.data, body.revision) };
  });
  app.get('/v1/workspaces', async (request) => ({ data: await store.scan('workspace', principal(request).id) }));
  app.get('/v1/workspaces/:id/write-lease', async (request) => {
    await existing<Workspace>(request, 'workspace');
    return { data: await new WorkspaceWriteLeaseService(store).get(principal(request).id, params(request).id) ?? null };
  });
  app.post('/v1/workspaces/:id/write-lease/reconcile', async (request) => {
    const owner = principal(request); requireOwner(owner); requireScope(owner, 'workspace:write');
    await existing<Workspace>(request, 'workspace');
    const body = z.object({ revision: z.number().int().positive(), verifiedStopped: z.literal(true), note: z.string().trim().min(1).max(2000) }).strict().parse(request.body);
    return { data: await new WorkspaceWriteLeaseService(store).reconcile(owner.id, params(request).id, body.revision, body.note) };
  });
  app.patch('/v1/workspaces/:id', async (request) => {
    const owner = principal(request); requireOwner(owner); requireScope(owner, 'workspace:write');
    const workspace = await existing<Workspace>(request, 'workspace');
    const body = z.object({
      revision: z.number().int().positive(),
      changes: z.object({ name: z.string().trim().min(1).max(200).optional(), capabilities: z.array(id).max(40).optional(), allowCloud: z.boolean().optional() }).strict(),
    }).strict().parse(request.body);
    body.changes.capabilities?.forEach((capability) => requireScope(owner, capability));
    return { data: await store.put('workspace', workspace.id, owner.id, { ...workspace.data, ...body.changes }, body.revision) };
  });
  app.get('/v1/tools', async (request) => {
    const owner = principal(request);
    return { data: (options.tools ?? []).filter((tool) => { try { tool.requiredCapabilities.forEach((capability) => requireScope(owner, capability)); return true; } catch { return false; } }).map(({ execute: _execute, ...tool }) => tool) };
  });
  app.post('/v1/workspaces/:id/operations', async (request, reply) => {
    const owner = principal(request); requireScope(owner, 'workspace:read');
    const workspace = await existing<Workspace>(request, 'workspace');
    const body = z.object({ tool: id, input: z.record(z.string(), z.unknown()), requestId: id }).strict().parse(request.body);
    const tool = options.tools?.find((candidate) => candidate.name === body.tool);
    if (!tool) throw new DomainError('tool_unavailable', 'Workspace tool is unavailable', 404);
    tool.requiredCapabilities.forEach((capability) => {
      requireScope(owner, capability);
      if (!workspace.data.capabilities.includes(capability)) {
        throw new DomainError('capability_required', `Workspace is not granted ${capability}`, 403);
      }
    });
    const conversationId = `operation-${createHash('sha256').update(`${owner.id}\0${workspace.id}\0${body.requestId}`).digest('hex')}`;
    const operation = { tool: body.tool, input: body.input };
    let conversation = await store.get<Conversation>('conversation', conversationId, owner.id);
    if (!conversation) {
      try { conversation = await store.create<Conversation>('conversation', owner.id, { title: tool.name, scope: 'private', mode: 'act', strategy: 'single', modelPolicy: 'local', workspaceId: workspace.id, archived: false, internalOperation: operation }, conversationId); }
      catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; conversation = await store.get<Conversation>('conversation', conversationId, owner.id); }
    }
    if (JSON.stringify(conversation?.data.internalOperation) !== JSON.stringify(operation)) throw new DomainError('idempotency_conflict', 'Request ID belongs to another operation', 409);
    return reply.code(202).send({ data: await tasks.enqueue(owner, conversationId, tool.name, body.requestId) });
  });
  app.post('/v1/workspaces', async (request, reply) => {
    const owner = principal(request); requireOwner(owner); requireScope(owner, 'workspace:write');
    const body = z.object({ name: z.string().min(1).max(200), root: z.string().startsWith('/').max(4096), deviceId: id, capabilities: z.array(id).max(40), allowCloud: z.boolean().default(false) }).strict().parse(request.body);
    if (body.deviceId !== 'server') await assertReference(owner.id, 'device', body.deviceId);
    return reply.code(201).send({ data: await store.create('workspace', owner.id, body) });
  });
  registerNotificationRoutes(app, notifications, principal);
  registerDeviceRoutes(app, devices, principal);
  registerDeviceSocket(app, devices, options.automations?.eventTriggersEnabled ? {
    connections: deviceConnections,
    onOnline: (edge) => eventTriggers.ingestDeviceOnline(edge),
  } : undefined);
  if (options.artifacts) await registerArtifactRoutes(app, options.artifacts, store, principal);
  return {
    app,
    tasks,
    devices,
    notifications,
    eventTriggers,
    scheduler,
    principal,
    setDegraded(value: boolean) { degraded = value; },
    isDegraded() { return degraded; },
    async close() { await tasks.close(); await app.close(); await store.close(); },
  };
}

function outageMessages(messages: OutageMessage[], conversationId: string) {
  return messages.map((message) => ({
    id: message.id,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    revision: 1,
    data: {
      conversationId,
      role: message.role,
      content: message.content,
      taskId: message.id.endsWith(':user') || message.id.endsWith(':assistant')
        ? message.id.slice(0, message.id.lastIndexOf(':'))
        : 'cached',
      ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
      degraded: true,
    },
    degraded: true,
  }));
}

declare module 'fastify' { interface FastifyContextConfig { public?: boolean; deviceAuth?: boolean; outageFallback?: boolean } }
