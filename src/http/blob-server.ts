import Fastify from 'fastify';
import { z } from 'zod';
import { developmentAuth } from '../auth.js';
import { DomainError } from '../contracts.js';
import { LocalBlobStore } from '../storage/blobs.js';

export function createBlobServer(options: { directory: string; token: string; tls?: { key: Buffer; cert: Buffer } }) {
  const app = Fastify({ bodyLimit: 32 * 1024 * 1024, ...(options.tls ? { https: options.tls } : {}) }); const auth = developmentAuth(options.token); const blobs = new LocalBlobStore(options.directory);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onRequest', async (request, reply) => { reply.header('cache-control', 'no-store'); await auth(request.headers.authorization); });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.statusCode : 503).send({ error: error instanceof DomainError ? error.code : 'storage_unavailable' }));
  const id = (params: unknown) => z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/) }).parse(params).id;
  app.get('/healthz', async () => {
    const { access, constants } = await import('node:fs/promises');
    await access(options.directory, constants.R_OK | constants.W_OK);
    return { ok: true };
  });
  app.put('/v1/blobs/:id', async (request) => ({ sha256: await blobs.put(id(request.params), request.body as Buffer) }));
  app.get('/v1/blobs/:id', async (request, reply) => reply.type('application/octet-stream').send(Buffer.from(await blobs.get(id(request.params)))));
  app.delete('/v1/blobs/:id', async (request, reply) => { await blobs.remove(id(request.params)); return reply.code(204).send(); });
  return app;
}
