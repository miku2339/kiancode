import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Principal } from '../contracts.js';
import type { MaintenanceService } from '../maintenance.js';

export function registerMaintenanceRoutes(app: FastifyInstance, maintenance: MaintenanceService, principal: (request: FastifyRequest) => Principal): void {
  app.get('/v1/maintenance', async (request) => ({ data: await maintenance.status(principal(request)) }));
  app.get('/v1/maintenance/activity', async (request) => {
    const query = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict().parse(request.query);
    return { data: await maintenance.activity(principal(request), query.before, query.limit) };
  });
  app.post('/v1/maintenance/cleanup', async (request) => ({ data: await maintenance.cleanExpiredActivity(principal(request)) }));
}
