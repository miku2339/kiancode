import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  HttpDeviceTransport,
  type DeviceJob,
  type DeviceJobResult,
  type DevicePairRequest,
  type DevicePairResponse,
  type HttpDeviceTransportOptions,
} from './device.js';
import { DomainError } from '../contracts.js';

interface AckWaiter {
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSocketDeviceTransport extends HttpDeviceTransport {
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private jobs: DeviceJob[] = [];
  private activeIds = new Set<string>();
  private waiters = new Map<string, AckWaiter>();
  private closed = false;

  public constructor(private options: HttpDeviceTransportOptions & { deviceId: string; onCancel?: (id: string) => void }) {
    super(options);
  }

  public override async pair(request: DevicePairRequest): Promise<DevicePairResponse> {
    const paired = await super.pair(request);
    this.options.token = paired.token;
    return paired;
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new DomainError('connector_stopped', 'Connector has stopped');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const url = new URL(`/v1/devices/${encodeURIComponent(this.options.deviceId)}/connect`, this.options.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.options.token ?? ''}` },
        handshakeTimeout: 10_000,
        maxPayload: 4 * 1024 * 1024,
        followRedirects: false,
      });
      let ready = false;
      const failOpening = (): void => {
        if (!ready) reject(new DomainError('device_transport_error', 'Device connection failed', 503));
      };
      this.socket = socket;
      socket.once('error', failOpening);
      socket.on('close', () => {
        this.socket = undefined;
        for (const id of this.activeIds) this.options.onCancel?.(id);
        const error = new DomainError('device_transport_error', 'Device connection closed', 503);
        for (const waiter of this.waiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.waiters.clear();
        failOpening();
      });
      socket.on('message', (raw) => {
        try {
          const event = JSON.parse(raw.toString()) as {
            type: string;
            deviceId?: string;
            requestId?: string;
            jobs?: DeviceJob[];
            ids?: string[];
            data?: unknown;
          };
          if (event.type === 'ready') {
            if (event.deviceId !== this.options.deviceId) throw new Error('device mismatch');
            ready = true;
            resolve();
            return;
          }
          if (event.type === 'jobs' && Array.isArray(event.jobs)) {
            if (this.jobs.length + event.jobs.length > 100) { socket.close(1008, 'Too many queued jobs'); return; }
            const seen = new Set([...this.jobs.map((job) => job.id), ...this.activeIds]);
            for (const job of event.jobs) if (!seen.has(job.id)) this.jobs.push(job);
            return;
          }
          if (event.type === 'cancel' && Array.isArray(event.ids)) {
            for (const id of event.ids) this.options.onCancel?.(id);
            return;
          }
          if (event.type === 'ack' && event.requestId) {
            const waiter = this.waiters.get(event.requestId);
            if (!waiter) return;
            this.waiters.delete(event.requestId);
            clearTimeout(waiter.timer);
            waiter.resolve(event.data);
            return;
          }
          throw new Error('unknown event');
        } catch {
          socket.close(1008, 'Invalid device message');
        }
      });
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async requestSocket<T>(type: 'heartbeat' | 'result' | 'poll', data: Record<string, unknown>): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new DomainError('device_transport_error', 'Device connection is unavailable', 503);
    }
    const requestId = randomUUID();
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new DomainError('device_transport_timeout', 'Device socket acknowledgement timed out', 504));
      }, this.options.timeoutMs ?? 30_000);
      timer.unref();
      this.waiters.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
    });
    socket.send(JSON.stringify({ type, ...data, requestId }), (error) => {
      if (!error) return;
      const waiter = this.waiters.get(requestId);
      if (!waiter) return;
      this.waiters.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.reject(new DomainError('device_transport_error', 'Device socket send failed', 503));
    });
    return response;
  }

  public override async heartbeat(deviceId: string, capabilities?: string[]): Promise<{ online: true; serverTime: string }> {
    this.assertDevice(deviceId);
    return this.requestSocket('heartbeat', capabilities ? { capabilities } : {});
  }

  public override async poll(deviceId: string): Promise<{ jobs: DeviceJob[] }> {
    this.assertDevice(deviceId);
    await this.connect();
    const jobs = this.jobs.splice(0);
    jobs.forEach((job) => this.activeIds.add(job.id));
    return { jobs };
  }

  public override async submitResult(deviceId: string, jobId: string, result: DeviceJobResult): Promise<void> {
    this.assertDevice(deviceId);
    await this.requestSocket('result', { jobId, result });
    this.activeIds.delete(jobId);
  }

  public close(): void {
    this.closed = true;
    for (const id of this.activeIds) this.options.onCancel?.(id);
    this.socket?.close();
  }

  private assertDevice(deviceId: string): void {
    if (deviceId !== this.options.deviceId) {
      throw new DomainError('device_mismatch', 'Device ID does not match the connection');
    }
  }
}
