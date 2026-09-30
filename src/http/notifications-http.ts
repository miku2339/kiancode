import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireOwner, requireScope } from '../auth.js';
import type { Principal } from '../contracts.js';
import type { NotificationService } from '../notifications.js';

const id = z.string().min(1).max(200);
const quietHours = z.object({
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict();

export function registerNotificationRoutes(
  app: FastifyInstance,
  notifications: NotificationService,
  principal: (request: FastifyRequest) => Principal,
): void {
  app.get('/v1/notifications/preferences', async (request) => {
    const owner = principal(request);
    requireOwner(owner);
    requireScope(owner, 'notification:read');
    return { data: await notifications.preferences(owner.id) };
  });

  app.put('/v1/notifications/preferences', async (request) => {
    const owner = principal(request);
    requireOwner(owner);
    requireScope(owner, 'notification:write');
    const body = z.object({
      revision: z.number().int().positive().optional(),
      timezone: z.string().min(1).max(100),
      quietHours: quietHours.nullable(),
    }).strict().parse(request.body);
    return {
      data: await notifications.setPreferences(owner.id, {
        timezone: body.timezone,
        quietHours: body.quietHours,
      }, body.revision),
    };
  });

  app.get('/v1/notifications/push-subscriptions', async (request) => {
    const owner = principal(request);
    requireOwner(owner);
    requireScope(owner, 'notification:read');
    return { data: await notifications.listPushSubscriptions(owner.id) };
  });

  app.post('/v1/notifications/push-subscriptions', async (request, reply) => {
    const owner = principal(request);
    requireOwner(owner);
    requireScope(owner, 'notification:write');
    const body = z.object({
      deviceId: id,
      platform: z.literal('apns'),
      environment: z.enum(['development', 'production']),
      topic: z.string().min(1).max(255),
      token: z.string().min(32).max(256),
    }).strict().parse(request.body);
    const subscription = await notifications.registerPushSubscription(
      owner.id,
      request.headers.authorization,
      body,
    );
    return reply.code(201).send({ data: subscription });
  });

  app.delete('/v1/notifications/push-subscriptions/:id', async (request, reply) => {
    const owner = principal(request);
    requireOwner(owner);
    requireScope(owner, 'notification:write');
    const params = z.object({ id }).parse(request.params);
    const query = z.object({ revision: z.coerce.number().int().positive() }).strict().parse(request.query);
    await notifications.revokePushSubscription(owner.id, params.id, 'user_revoked', query.revision);
    return reply.code(204).send();
  });

  app.get('/v1/notifications', async (request) => {
    const owner = principal(request);
    requireOwner(owner);
    requireScope(owner, 'notification:read');
    return {
      data: (await notifications.list(owner.id))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)),
    };
  });

  app.post('/v1/notifications/:id/read', async (request) => {
    const owner = principal(request);
    requireOwner(owner);
    requireScope(owner, 'notification:write');
    const params = z.object({ id }).parse(request.params);
    return { data: await notifications.markRead(owner.id, params.id) };
  });
}
