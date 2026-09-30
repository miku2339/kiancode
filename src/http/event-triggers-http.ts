import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireOwner, requireScope } from '../auth.js';
import type { Principal } from '../contracts.js';
import {
  EventTriggerService,
  type DeviceOnlineFilter,
  type EventTriggerInput,
  type WebhookFilter,
} from '../event-triggers.js';
import { SchedulerService } from '../scheduler.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const text = z.string().trim().min(1).max(64_000);
const notification = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('in_app') }).strict(),
  z.object({ type: z.literal('push'), subscriptionId: id }).strict(),
  z.object({ type: z.literal('channel'), destinationId: id }).strict(),
]);
const settings = z.object({
  conversationId: id,
  permissions: z.array(z.string().min(3).max(100)).min(1).max(40),
  notification,
}).strict();
const webhookFilter = z.object({
  eventName: id.max(100).optional(),
  equals: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){0,4}$/),
    z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
  ).optional(),
}).strict();
const deviceFilter = z.object({ deviceIds: z.array(id).max(40).optional() }).strict();
const triggerInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webhook'),
    name: z.string().trim().min(1).max(120),
    prompt: text.max(32_000),
    enabled: z.boolean().default(false),
    settings,
    filter: webhookFilter.default({}),
  }).strict(),
  z.object({
    type: z.literal('device_online'),
    name: z.string().trim().min(1).max(120),
    prompt: text.max(32_000),
    enabled: z.boolean().default(false),
    settings,
    filter: deviceFilter.default({}),
  }).strict(),
]);
const scheduleBase = {
  name: z.string().trim().min(1).max(120),
  prompt: text,
  enabled: z.boolean().default(false),
  settings,
};
const scheduleInput = z.union([
  z.object({
    ...scheduleBase,
    nextAt: z.iso.datetime(),
    intervalSeconds: z.number().int().min(60).max(31_536_000).optional(),
  }).strict(),
  z.object({
    ...scheduleBase,
    cronExpression: z.string().trim().min(1).max(200),
    timezone: z.string().trim().min(1).max(100),
  }).strict(),
]);
const webhookEvent = z.object({
  eventId: id,
  eventName: id.max(100),
  payload: z.record(z.string().max(100), z.unknown()).default({}),
}).strict();

export function registerAutomationRoutes(
  app: FastifyInstance,
  services: { eventTriggers: EventTriggerService; scheduler: SchedulerService },
  principal: (request: FastifyRequest) => Principal,
): void {
  app.get('/v1/event-triggers', async (request) => {
    const owner = automationOwner(principal(request), 'schedule:read');
    return { data: await services.eventTriggers.list(owner.id) };
  });

  app.post('/v1/event-triggers', async (request, reply) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const created = await services.eventTriggers.create(owner, triggerInput.parse(request.body) as EventTriggerInput);
    return reply.code(201).send({
      data: created.trigger,
      ...(created.secret ? { webhook: { id: created.trigger.data.webhook?.id, secret: created.secret } } : {}),
    });
  });

  app.put('/v1/event-triggers/:id', async (request) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const params = z.object({ id }).parse(request.params);
    const body = z.object({
      revision: z.number().int().positive(),
      data: triggerInput,
    }).strict().parse(request.body);
    return { data: await services.eventTriggers.update(owner, params.id, body.revision, body.data as EventTriggerInput) };
  });

  app.post('/v1/event-triggers/:id/rotate-secret', async (request) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const params = z.object({ id }).parse(request.params);
    const body = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
    const rotated = await services.eventTriggers.rotateSecret(owner, params.id, body.revision);
    return { data: rotated.trigger, webhook: { id: rotated.trigger.data.webhook?.id, secret: rotated.secret } };
  });

  app.delete('/v1/event-triggers/:id', async (request, reply) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const params = z.object({ id }).parse(request.params);
    const query = z.object({ revision: z.coerce.number().int().positive() }).strict().parse(request.query);
    await services.eventTriggers.remove(owner, params.id, query.revision);
    return reply.code(204).send();
  });

  app.post('/v1/event-hooks/:webhookId', {
    bodyLimit: 64 * 1024,
    config: { public: true },
  }, async (request, reply) => {
    const params = z.object({ webhookId: z.string().min(20).max(100) }).parse(request.params);
    const secretHeader = request.headers['x-kian-webhook-secret'];
    const secret = typeof secretHeader === 'string' ? secretHeader : undefined;
    const body = webhookEvent.parse(request.body);
    const inbox = await services.eventTriggers.ingestWebhook(params.webhookId, secret, body);
    return reply.code(202).send({ data: { eventId: inbox.data.eventId, status: inbox.data.status } });
  });

  app.get('/v1/schedules', async (request) => {
    const owner = automationOwner(principal(request), 'schedule:read');
    return { data: await services.scheduler.list(owner.id) };
  });

  app.get('/v1/schedule-drafts', async (request) => {
    const owner = automationOwner(principal(request), 'schedule:read');
    return { data: await services.scheduler.listDrafts(owner.id) };
  });

  app.delete('/v1/schedule-drafts/:id', async (request, reply) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const params = z.object({ id }).parse(request.params);
    const query = z.object({ revision: z.coerce.number().int().positive() }).strict().parse(request.query);
    await services.scheduler.removeDraft(owner, params.id, query.revision);
    return reply.code(204).send();
  });

  app.post('/v1/schedules', async (request, reply) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    return reply.code(201).send({ data: await services.scheduler.create(owner, scheduleInput.parse(request.body)) });
  });

  app.put('/v1/schedules/:id', async (request) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const params = z.object({ id }).parse(request.params);
    const body = z.object({ revision: z.number().int().positive(), data: scheduleInput }).strict().parse(request.body);
    return { data: await services.scheduler.update(owner, params.id, body.revision, body.data) };
  });

  app.patch('/v1/schedules/:id', async (request) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const params = z.object({ id }).parse(request.params);
    const body = z.object({ revision: z.number().int().positive(), enabled: z.boolean() }).strict().parse(request.body);
    return { data: await services.scheduler.setEnabled(owner, params.id, body.revision, body.enabled) };
  });

  app.delete('/v1/schedules/:id', async (request, reply) => {
    const owner = automationOwner(principal(request), 'schedule:write');
    const params = z.object({ id }).parse(request.params);
    const query = z.object({ revision: z.coerce.number().int().positive() }).strict().parse(request.query);
    await services.scheduler.remove(owner, params.id, query.revision);
    return reply.code(204).send();
  });
}

function automationOwner(principal: Principal, scope: 'schedule:read' | 'schedule:write'): Principal {
  requireOwner(principal);
  requireScope(principal, scope);
  return principal;
}

export type EventTriggerHttpContract = {
  webhookFilter: WebhookFilter;
  deviceOnlineFilter: DeviceOnlineFilter;
};
