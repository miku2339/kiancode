import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../contracts.js';
import type { DeviceService } from '../devices.js';
import type { DeviceConnectionEdge, ValidatedDeviceConnection } from '../event-triggers.js';
import { WORKSPACE_EXPORT_MIME_TYPES } from '../tools/workspace-export.js';

const result = z.object({
  status: z.enum(['confirmed', 'failed', 'unknown', 'cancelled']),
  result: z.object({
    content: z.string().max(500_000),
    isError: z.boolean().optional(),
  }).strict().optional(),
  inlineArtifacts: z.array(z.object({
    name: z.string().min(1).max(255),
    mimeType: z.enum(WORKSPACE_EXPORT_MIME_TYPES),
    bytesBase64: z.string().min(4).max(8 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: z.iso.datetime(),
  }).strict()).max(2).optional(),
  error: z.string().max(2_000).optional(),
}).strict();

const clientEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat'), requestId: z.string().min(1).max(100), capabilities: z.array(z.string().max(100)).max(40).optional() }).strict(),
  z.object({ type: z.literal('poll'), requestId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('result'), requestId: z.string().min(1).max(100), jobId: z.string().min(1).max(200), result }).strict(),
]);

interface ActiveDeviceConnection extends ValidatedDeviceConnection {
  connectedAt: string;
  consumed: boolean;
}

export class DeviceConnectionRegistry {
  private readonly active = new Map<string, ActiveDeviceConnection>();

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly validationWindowMs = 60_000,
  ) {}

  public open(device: { id: string; ownerId: string }): DeviceConnectionEdge {
    this.prune();
    const edge = {
      deviceId: device.id,
      connectionId: randomUUID(),
      connectedAt: new Date(this.now()).toISOString(),
    };
    this.active.set(edge.connectionId, {
      ownerId: device.ownerId,
      deviceId: device.id,
      connectedAt: edge.connectedAt,
      consumed: false,
    });
    return edge;
  }

  public async validate(edge: DeviceConnectionEdge): Promise<ValidatedDeviceConnection> {
    this.prune();
    const current = this.active.get(edge.connectionId);
    if (!current || current.consumed || current.deviceId !== edge.deviceId
      || current.connectedAt !== edge.connectedAt) {
      throw new DomainError('invalid_device_edge', 'Device connection edge is not active.', 403);
    }
    current.consumed = true;
    return { ownerId: current.ownerId, deviceId: current.deviceId };
  }

  public close(connectionId: string): void {
    this.active.delete(connectionId);
  }

  private prune(): void {
    for (const [id, edge] of this.active) {
      if (Date.parse(edge.connectedAt) + this.validationWindowMs < this.now()) this.active.delete(id);
    }
  }
}

export interface DeviceSocketOptions {
  connections: DeviceConnectionRegistry;
  onOnline(edge: DeviceConnectionEdge): Promise<unknown>;
}

export function registerDeviceSocket(app: FastifyInstance, devices: DeviceService, options?: DeviceSocketOptions) {
  app.get('/v1/devices/:id/connect', { websocket: true, config: { deviceAuth: true } }, (socket, request) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    let closed = false;
    let lastPong = Date.now();
    let busy = false;
    let connectionId: string | undefined;
    let messageQueue = Promise.resolve();
    const send = (event: unknown): void => {
      if (!closed && socket.readyState === socket.OPEN && socket.bufferedAmount <= 4 * 1024 * 1024) {
        socket.send(JSON.stringify(event));
      }
    };
    const authenticate = () => devices.authenticate(request.headers.authorization, id);
    const tick = async () => {
      if (closed || busy) return;
      if (Date.now() - lastPong > 30_000) { socket.terminate(); return; }
      busy = true;
      try {
        const device = await authenticate();
        if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, 'Backpressure'); return; }
        const { jobs } = await devices.poll(device);
        if (jobs.length) send({ type: 'jobs', jobs });
        const cancellations = await devices.cancellations(device);
        if (cancellations.length) send({ type: 'cancel', ids: cancellations });
        socket.ping();
      } catch {
        socket.close(1011, 'Device authorization or storage unavailable');
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, 1_000);
    timer.unref();
    socket.on('pong', () => { lastPong = Date.now(); });
    const close = () => {
      closed = true;
      clearInterval(timer);
      if (connectionId) options?.connections.close(connectionId);
    };
    socket.on('close', close);
    socket.on('error', close);
    socket.on('message', (raw) => {
      messageQueue = messageQueue.then(async () => {
        const event = clientEvent.parse(JSON.parse(raw.toString()));
        const device = await authenticate();
        if (event.type === 'heartbeat') {
          const response = await devices.heartbeat(device, event.capabilities);
          send({ type: 'ack', requestId: event.requestId, data: response });
          return;
        }
        if (event.type === 'result') {
          await devices.submit(device, event.jobId, event.result);
          send({ type: 'ack', requestId: event.requestId });
          return;
        }
        await tick();
        send({ type: 'ack', requestId: event.requestId });
      }).catch(() => socket.close(1008, 'Invalid or unauthorized device message'));
    });
    void authenticate().then(async (device) => {
      const heartbeat = await devices.heartbeat(device);
      if (options) {
        const edge = options.connections.open(device);
        connectionId = edge.connectionId;
        await options.onOnline(edge);
      }
      send({ type: 'ready', deviceId: id, data: heartbeat });
      return tick();
    }).catch(() => socket.close(1008, 'Device authorization or storage unavailable'));
  });
}
