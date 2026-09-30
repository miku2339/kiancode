import { randomUUID } from 'node:crypto';
import { DomainError } from '../contracts.js';
import type { ChatAttachment } from './types.js';

export interface VisualFrameInput {
  ownerId: string;
  conversationId: string;
  sessionId: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: Uint8Array;
}

export interface EphemeralAttachmentPayload {
  messageIndex: number;
  attachmentIndex: number;
  mimeType: string;
  data: string;
}

export interface EphemeralModelPayload {
  attachments: EphemeralAttachmentPayload[];
}

export interface EphemeralPayloadStore {
  stagePayload(ownerId: string, taskId: string, payload: EphemeralModelPayload): string;
  consumePayload(ownerId: string, taskId: string, reference: string): EphemeralModelPayload | undefined;
}

export interface VisualContextStoreOptions {
  ttlMs?: number;
  payloadTtlMs?: number;
  maxFrameBytes?: number;
  maxBytes?: number;
  maxEntries?: number;
  now?: () => number;
}

interface FrameEntry {
  kind: 'frame';
  key: string;
  ownerId: string;
  conversationId: string;
  sessionId: string;
  mimeType: VisualFrameInput['mimeType'];
  data: Uint8Array;
  size: number;
  expiresAt: number;
  order: number;
}

interface PayloadEntry {
  kind: 'payload';
  key: string;
  ownerId: string;
  taskId: string;
  payload: EphemeralModelPayload;
  size: number;
  expiresAt: number;
  order: number;
}

type Entry = FrameEntry | PayloadEntry;

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export class VisualContextStore implements EphemeralPayloadStore {
  private readonly ttlMs: number;
  private readonly payloadTtlMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly frames = new Map<string, FrameEntry>();
  private readonly payloads = new Map<string, PayloadEntry>();
  private usedBytes = 0;
  private order = 0;

  public constructor(options: VisualContextStoreOptions = {}) {
    this.ttlMs = boundedOption(options.ttlMs, 30_000, 'ttlMs');
    this.payloadTtlMs = boundedOption(options.payloadTtlMs, 300_000, 'payloadTtlMs');
    this.maxFrameBytes = boundedOption(options.maxFrameBytes, 8 * 1024 * 1024, 'maxFrameBytes');
    this.maxBytes = boundedOption(options.maxBytes, 32 * 1024 * 1024, 'maxBytes');
    this.maxEntries = boundedOption(options.maxEntries, 64, 'maxEntries');
    this.now = options.now ?? Date.now;
  }

  public pushFrame(input: VisualFrameInput): void {
    this.validateKey(input.ownerId, 'ownerId');
    this.validateKey(input.conversationId, 'conversationId');
    this.validateKey(input.sessionId, 'sessionId');
    if (!imageTypes.has(input.mimeType)) {
      throw new DomainError('invalid_visual_frame', 'Visual context must be a supported image.', 400);
    }
    const data = Uint8Array.from(input.data);
    if (data.byteLength === 0 || data.byteLength > this.maxFrameBytes) {
      throw new DomainError('visual_frame_too_large', 'Visual context exceeds the frame size limit.', 413);
    }
    this.purgeExpired();
    const key = frameKey(input.ownerId, input.conversationId, input.sessionId);
    const previous = this.frames.get(key);
    if (previous) this.deleteEntry(previous);
    this.makeRoom(data.byteLength);
    const entry: FrameEntry = {
      kind: 'frame',
      key,
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      mimeType: input.mimeType,
      data,
      size: data.byteLength,
      expiresAt: this.now() + this.ttlMs,
      order: ++this.order,
    };
    this.frames.set(key, entry);
    this.usedBytes += entry.size;
  }

  public takeLatest(ownerId: string, conversationId: string): ChatAttachment | undefined {
    this.purgeExpired();
    let latest: FrameEntry | undefined;
    const matching: FrameEntry[] = [];
    for (const frame of this.frames.values()) {
      if (frame.ownerId !== ownerId || frame.conversationId !== conversationId) continue;
      matching.push(frame);
      if (!latest || frame.order > latest.order) latest = frame;
    }
    if (!latest) return undefined;
    for (const frame of matching) this.deleteEntry(frame);
    return {
      mimeType: latest.mimeType,
      data: Buffer.from(latest.data).toString('base64'),
      ephemeral: true,
    };
  }

  public clear(ownerId: string, conversationId: string, sessionId?: string): void {
    this.purgeExpired();
    for (const frame of [...this.frames.values()]) {
      if (frame.ownerId === ownerId && frame.conversationId === conversationId
        && (sessionId === undefined || frame.sessionId === sessionId)) {
        this.deleteEntry(frame);
      }
    }
  }

  public stagePayload(ownerId: string, taskId: string, payload: EphemeralModelPayload): string {
    this.validateKey(ownerId, 'ownerId');
    this.validateKey(taskId, 'taskId');
    if (payload.attachments.length === 0 || payload.attachments.length > 10) {
      throw new DomainError('invalid_ephemeral_payload', 'Ephemeral model payload must contain one to ten images.', 400);
    }
    const attachments = payload.attachments.map((attachment) => {
      if (!Number.isSafeInteger(attachment.messageIndex) || attachment.messageIndex < 0
        || !Number.isSafeInteger(attachment.attachmentIndex) || attachment.attachmentIndex < 0
        || !imageTypes.has(attachment.mimeType) || typeof attachment.data !== 'string') {
        throw new DomainError('invalid_ephemeral_payload', 'Ephemeral model payload is invalid.', 400);
      }
      const size = Buffer.byteLength(attachment.data, 'base64');
      if (size === 0 || size > this.maxFrameBytes) {
        throw new DomainError('visual_frame_too_large', 'Visual context exceeds the frame size limit.', 413);
      }
      return { ...attachment, data: `${attachment.data}` };
    });
    const size = attachments.reduce((total, attachment) => total + Buffer.byteLength(attachment.data, 'base64'), 0);
    this.purgeExpired();
    this.makeRoom(size);
    const reference = randomUUID();
    const entry: PayloadEntry = {
      kind: 'payload',
      key: reference,
      ownerId,
      taskId,
      payload: { attachments },
      size,
      expiresAt: this.now() + this.payloadTtlMs,
      order: ++this.order,
    };
    this.payloads.set(reference, entry);
    this.usedBytes += size;
    return reference;
  }

  public consumePayload(ownerId: string, taskId: string, reference: string): EphemeralModelPayload | undefined {
    this.purgeExpired();
    const entry = this.payloads.get(reference);
    if (!entry || entry.ownerId !== ownerId || entry.taskId !== taskId) return undefined;
    this.deleteEntry(entry);
    return {
      attachments: entry.payload.attachments.map((attachment) => ({ ...attachment })),
    };
  }

  public stats(): { entries: number; bytes: number } {
    this.purgeExpired();
    return { entries: this.frames.size + this.payloads.size, bytes: this.usedBytes };
  }

  private makeRoom(size: number): void {
    if (size > this.maxBytes) {
      throw new DomainError('visual_context_capacity', 'Visual context exceeds the in-memory limit.', 413);
    }
    while (this.usedBytes + size > this.maxBytes || this.frames.size + this.payloads.size >= this.maxEntries) {
      const oldest = this.oldestEntry();
      if (!oldest) break;
      this.deleteEntry(oldest);
    }
  }

  private oldestEntry(): Entry | undefined {
    let oldest: Entry | undefined;
    for (const entry of [...this.frames.values(), ...this.payloads.values()]) {
      if (!oldest || entry.order < oldest.order) oldest = entry;
    }
    return oldest;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const entry of [...this.frames.values(), ...this.payloads.values()]) {
      if (entry.expiresAt <= now) this.deleteEntry(entry);
    }
  }

  private deleteEntry(entry: Entry): void {
    const deleted = entry.kind === 'frame'
      ? this.frames.delete(entry.key)
      : this.payloads.delete(entry.key);
    if (deleted) this.usedBytes -= entry.size;
  }

  private validateKey(value: string, name: string): void {
    if (!value || value.length > 200 || value.includes('\0')) {
      throw new DomainError('invalid_visual_context', `${name} is invalid.`, 400);
    }
  }
}

function frameKey(ownerId: string, conversationId: string, sessionId: string): string {
  return `${ownerId.length}:${ownerId}${conversationId.length}:${conversationId}${sessionId.length}:${sessionId}`;
}

function boundedOption(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`${name} must be a positive integer.`);
  return selected;
}
