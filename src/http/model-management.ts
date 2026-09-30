import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireOwner, requireScope } from '../auth.js';
import type { Principal } from '../contracts.js';
import { ModelManagement, modelSettingsSchema, providerSettingsSchema } from '../model-management.js';

const params = z.object({ id: z.string().min(1).max(128) });
const revision = z.number().int().nonnegative();

export function registerModelManagementRoutes(app: FastifyInstance, service: ModelManagement, principal: (request: FastifyRequest) => Principal): void {
  const reader = (request: FastifyRequest) => {
    const actor = principal(request);
    requireOwner(actor);
    requireScope(actor, 'model:read');
    return actor;
  };
  app.get('/v1/providers', async (request) => ({ data: await service.providers(reader(request).id) }));
  app.put('/v1/providers/:id', async (request) => {
    const body = z.object({ revision, settings: providerSettingsSchema, apiKey: z.string().max(16384).nullable().optional() }).strict().parse(request.body);
    return { data: await service.saveProvider(principal(request), params.parse(request.params).id, body.settings, body.revision, body.apiKey) };
  });
  app.delete('/v1/providers/:id', async (request, reply) => {
    const query = z.object({ revision: z.coerce.number().int().nonnegative() }).strict().parse(request.query);
    await service.disableProvider(principal(request), params.parse(request.params).id, query.revision);
    return reply.code(204).send();
  });
  app.get('/v1/models/usage', async (request) => ({ data: await service.usage(reader(request).id) }));
  app.put('/v1/models/:id', async (request) => {
    const body = z.object({ revision, settings: modelSettingsSchema }).strict().parse(request.body);
    return { data: await service.saveModel(principal(request), params.parse(request.params).id, body.settings, body.revision) };
  });
  app.delete('/v1/models/:id', async (request, reply) => {
    const query = z.object({ revision: z.coerce.number().int().nonnegative() }).strict().parse(request.query);
    await service.disableModel(principal(request), params.parse(request.params).id, query.revision);
    return reply.code(204).send();
  });
  app.post('/v1/models/:id/probe', async (request) => {
    const body = z.object({ capabilities: z.array(z.enum(['tools', 'vision'])).max(2).default([]) }).strict().parse(request.body ?? {});
    return { data: await service.probe(principal(request), params.parse(request.params).id, body.capabilities) };
  });
}
