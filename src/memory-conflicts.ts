import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireOwner, requireScope } from './auth.js';
import { DomainError, type Principal } from './contracts.js';
import type { Memory } from './domain.js';
import { memoryApproved } from './memory-query.js';
import type { Entity, Store } from './storage/store.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/);
const memoryImportCandidateSchema = z.object({
  type: z.enum(['persona', 'preference', 'episode', 'project', 'agent', 'document']),
  text: z.string().min(1).max(1_000_000),
  scope: z.enum(['private', 'group', 'workspace', 'agent']),
  scopeId: identifier.optional(),
  source: z.string().min(1).max(2048),
  provenance: z.record(z.string(), z.unknown()).optional(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().optional(),
  replacesId: identifier.optional(),
}).strict().superRefine((value, context) => {
  if (value.scope !== 'private' && !value.scopeId) {
    context.addIssue({ code: 'custom', message: 'Scoped memory requires scopeId' });
  }
  if (value.validTo && Date.parse(value.validTo) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: 'custom', message: 'validTo must be later than validFrom' });
  }
});

export type MemoryImportCandidate = z.infer<typeof memoryImportCandidateSchema>;
export type MemoryReviewCause = 'manual_review' | 'id_conflict' | 'replacement_missing' | 'replacement_scope_mismatch';
export type MemoryReviewDecision = 'approve' | 'reject' | 'keep_existing';

export interface MemoryConflict {
  candidateId: string;
  candidate: MemoryImportCandidate;
  fingerprint: string;
  status: 'held' | 'conflict' | 'resolved';
  cause: MemoryReviewCause;
  reason: string;
  existingMemoryId?: string;
  existingRevision?: number;
  resolution?: {
    decision: MemoryReviewDecision;
    reviewerId: string;
    resolvedAt: string;
    memoryId?: string;
  };
}

export interface MemoryImportRequest {
  id: string;
  memory: MemoryImportCandidate;
  disposition?: 'approved' | 'held';
  reason?: string;
}

export interface MemoryImportResult {
  outcome: 'imported' | 'deduplicated' | 'held' | 'conflict' | 'rejected' | 'kept_existing';
  memory?: Entity<Memory>;
  review?: Entity<MemoryConflict>;
}

export interface MemoryReviewQuery {
  id?: string;
  status?: MemoryConflict['status'];
  limit?: number;
}

export interface MemoryResolution {
  expectedRevision: number;
  decision: MemoryReviewDecision;
  memoryId?: string;
}

export class MemoryConflictService {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  public async import(actor: Principal, request: MemoryImportRequest): Promise<MemoryImportResult> {
    this.write(actor);
    const candidateId = identifier.parse(request.id);
    const candidate = memoryImportCandidateSchema.parse(request.memory);
    const fingerprint = memoryFingerprint(candidate);
    const reviewId = memoryReviewId(actor.id, candidateId, fingerprint);
    const priorReview = await this.store.get<MemoryConflict>('memory_review', reviewId, actor.id);
    if (priorReview) return this.reviewOutcome(actor, priorReview);

    if ((request.disposition ?? 'held') === 'held') {
      return {
        outcome: 'held',
        review: await this.createReview(actor.id, reviewId, {
          candidateId,
          candidate,
          fingerprint,
          status: 'held',
          cause: 'manual_review',
          reason: validReason(request.reason ?? 'Imported memory requires review.'),
        }),
      };
    }

    const replacementConflict = await this.replacementConflict(actor.id, candidate);
    if (replacementConflict) {
      return {
        outcome: 'conflict',
        review: await this.createReview(actor.id, reviewId, {
          candidateId,
          candidate,
          fingerprint,
          status: 'conflict',
          ...replacementConflict,
        }),
      };
    }

    const existing = await this.store.get<Memory>('memory', candidateId, actor.id);
    if (existing) return this.existingOutcome(actor.id, reviewId, candidateId, candidate, fingerprint, existing);
    const memory = approvedMemory(candidate, actor.id, this.now());
    try {
      return { outcome: 'imported', memory: await this.store.create<Memory>('memory', actor.id, memory, candidateId) };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'conflict') throw error;
      const raced = await this.store.get<Memory>('memory', candidateId, actor.id);
      if (!raced) throw error;
      return this.existingOutcome(actor.id, reviewId, candidateId, candidate, fingerprint, raced);
    }
  }

  public async review(actor: Principal, query: MemoryReviewQuery = {}): Promise<Array<Entity<MemoryConflict>>> {
    this.read(actor);
    const id = query.id ? identifier.parse(query.id) : undefined;
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    if (id) {
      const row = await this.store.get<MemoryConflict>('memory_review', id, actor.id);
      return row && (!query.status || row.data.status === query.status) ? [row] : [];
    }
    return (await this.store.scan<MemoryConflict>('memory_review', actor.id))
      .filter((row) => !query.status || row.data.status === query.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, limit);
  }

  public async resolve(actor: Principal, reviewId: string, input: MemoryResolution): Promise<MemoryImportResult> {
    this.write(actor);
    identifier.parse(reviewId);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new DomainError('invalid_revision', 'A positive review revision is required');
    }
    const review = await this.store.get<MemoryConflict>('memory_review', reviewId, actor.id);
    if (!review) throw new DomainError('not_found', 'Memory review not found', 404);
    if (review.revision !== input.expectedRevision) throw new DomainError('conflict', 'Memory review has changed', 409);
    if (review.data.status === 'resolved') return this.resolvedOutcome(actor, review, input.decision);

    if (input.decision === 'reject' || input.decision === 'keep_existing') {
      if (input.decision === 'keep_existing' && review.data.cause !== 'id_conflict') {
        throw new DomainError('invalid_resolution', 'There is no existing memory to keep');
      }
      const resolved = await this.finishReview(actor, review, input.decision,
        input.decision === 'keep_existing' ? review.data.existingMemoryId : undefined);
      const memory = resolved.data.resolution?.memoryId
        ? await this.store.get<Memory>('memory', resolved.data.resolution.memoryId, actor.id)
        : undefined;
      return { outcome: input.decision === 'reject' ? 'rejected' : 'kept_existing', review: resolved, ...(memory ? { memory } : {}) };
    }

    if (review.data.cause === 'replacement_missing' || review.data.cause === 'replacement_scope_mismatch') {
      throw new DomainError('invalid_replacement', 'Resolve the replacement target before approving this memory', 409);
    }
    const memoryId = identifier.parse(input.memoryId ?? review.data.candidateId);
    if (review.data.cause === 'id_conflict' && memoryId === review.data.candidateId) {
      throw new DomainError('memory_id_conflict', 'Approve the incoming memory under a different ID or keep the existing record', 409);
    }
    const replacementConflict = await this.replacementConflict(actor.id, review.data.candidate);
    if (replacementConflict) throw new DomainError('invalid_replacement', replacementConflict.reason, 409);
    const staged = await this.stageMemory(actor, memoryId, review.data);
    const resolved = await this.finishReview(actor, review, 'approve', memoryId);
    const memory = await this.activateMemory(actor, staged, review.data.candidate);
    return { outcome: 'imported', review: resolved, memory };
  }

  private async existingOutcome(
    ownerId: string,
    reviewId: string,
    candidateId: string,
    candidate: MemoryImportCandidate,
    fingerprint: string,
    existing: Entity<Memory>,
  ): Promise<MemoryImportResult> {
    if (memoryApproved(existing.data) && memoryFingerprint(memoryCandidate(existing.data)) === fingerprint) {
      return { outcome: 'deduplicated', memory: existing };
    }
    return {
      outcome: 'conflict',
      review: await this.createReview(ownerId, reviewId, {
        candidateId,
        candidate,
        fingerprint,
        status: 'conflict',
        cause: 'id_conflict',
        reason: 'A different memory already uses this import ID.',
        existingMemoryId: existing.id,
        existingRevision: existing.revision,
      }),
    };
  }

  private async replacementConflict(
    ownerId: string,
    candidate: MemoryImportCandidate,
  ): Promise<Pick<MemoryConflict, 'cause' | 'reason' | 'existingMemoryId' | 'existingRevision'> | undefined> {
    if (!candidate.replacesId) return undefined;
    const target = await this.store.get<Memory>('memory', candidate.replacesId, ownerId);
    if (!target || !memoryApproved(target.data)) {
      return { cause: 'replacement_missing', reason: 'The replacement target is missing or not approved.', existingMemoryId: candidate.replacesId };
    }
    if (target.data.scope !== candidate.scope || target.data.scopeId !== candidate.scopeId) {
      return {
        cause: 'replacement_scope_mismatch',
        reason: 'The replacement target belongs to a different memory scope.',
        existingMemoryId: target.id,
        existingRevision: target.revision,
      };
    }
    return undefined;
  }

  private async createReview(ownerId: string, id: string, data: MemoryConflict): Promise<Entity<MemoryConflict>> {
    try {
      return await this.store.create('memory_review', ownerId, data, id);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'conflict') throw error;
      const existing = await this.store.get<MemoryConflict>('memory_review', id, ownerId);
      if (!existing || existing.data.fingerprint !== data.fingerprint) throw error;
      return existing;
    }
  }

  private async stageMemory(actor: Principal, id: string, review: MemoryConflict): Promise<Entity<Memory>> {
    const existing = await this.store.get<Memory>('memory', id, actor.id);
    if (existing) {
      if (memoryFingerprint(memoryCandidate(existing.data)) !== review.fingerprint) {
        throw new DomainError('memory_id_conflict', 'The selected memory ID is already in use', 409);
      }
      return existing;
    }
    return this.store.create<Memory>('memory', actor.id, {
      ...review.candidate,
      reviewStatus: 'held',
      reviewReason: review.reason,
    }, id);
  }

  private async finishReview(
    actor: Principal,
    review: Entity<MemoryConflict>,
    decision: MemoryReviewDecision,
    memoryId?: string,
  ): Promise<Entity<MemoryConflict>> {
    return this.store.put('memory_review', review.id, actor.id, {
      ...review.data,
      status: 'resolved',
      resolution: {
        decision,
        reviewerId: actor.id,
        resolvedAt: new Date(this.now()).toISOString(),
        ...(memoryId ? { memoryId } : {}),
      },
    }, review.revision);
  }

  private async activateMemory(
    actor: Principal,
    memory: Entity<Memory>,
    candidate: MemoryImportCandidate,
  ): Promise<Entity<Memory>> {
    if (memoryApproved(memory.data)) return memory;
    return this.store.put('memory', memory.id, actor.id, approvedMemory(candidate, actor.id, this.now()), memory.revision);
  }

  private async reviewOutcome(actor: Principal, review: Entity<MemoryConflict>): Promise<MemoryImportResult> {
    if (review.data.status !== 'resolved') {
      return { outcome: review.data.status, review };
    }
    const resolution = review.data.resolution;
    if (resolution?.decision === 'approve') return this.resolvedOutcome(actor, review, resolution.decision);
    if (resolution?.decision === 'keep_existing') {
      const memory = resolution.memoryId
        ? await this.store.get<Memory>('memory', resolution.memoryId, actor.id)
        : undefined;
      return { outcome: 'kept_existing', review, ...(memory ? { memory } : {}) };
    }
    return { outcome: 'rejected', review };
  }

  private async resolvedOutcome(
    actor: Principal,
    review: Entity<MemoryConflict>,
    requestedDecision: MemoryReviewDecision,
  ): Promise<MemoryImportResult> {
    const resolution = review.data.resolution;
    if (!resolution || resolution.decision !== requestedDecision) {
      throw new DomainError('review_resolved', 'Memory review was already resolved differently', 409);
    }
    if (resolution.decision === 'approve' && resolution.memoryId) {
      const staged = await this.store.get<Memory>('memory', resolution.memoryId, actor.id);
      if (!staged) throw new DomainError('memory_activation_incomplete', 'Approved memory is missing', 409);
      const memory = await this.activateMemory(actor, staged, review.data.candidate);
      return { outcome: 'imported', review, memory };
    }
    if (resolution.decision === 'keep_existing' && resolution.memoryId) {
      const memory = await this.store.get<Memory>('memory', resolution.memoryId, actor.id);
      return { outcome: 'kept_existing', review, ...(memory ? { memory } : {}) };
    }
    return { outcome: 'rejected', review };
  }

  private read(actor: Principal): void {
    requireOwner(actor);
    requireScope(actor, 'memory:read');
  }

  private write(actor: Principal): void {
    requireOwner(actor);
    requireScope(actor, 'memory:write');
  }
}

function memoryCandidate(memory: Memory): MemoryImportCandidate {
  return memoryImportCandidateSchema.parse({
    type: memory.type,
    text: memory.text,
    scope: memory.scope,
    ...(memory.scopeId ? { scopeId: memory.scopeId } : {}),
    source: memory.source,
    ...(memory.provenance ? { provenance: memory.provenance } : {}),
    validFrom: memory.validFrom,
    ...(memory.validTo ? { validTo: memory.validTo } : {}),
    ...(memory.replacesId ? { replacesId: memory.replacesId } : {}),
  });
}

function memoryFingerprint(memory: MemoryImportCandidate): string {
  return createHash('sha256').update(stableJson(memoryImportCandidateSchema.parse(memory))).digest('hex');
}

function memoryReviewId(ownerId: string, candidateId: string, fingerprint: string): string {
  return `memory_review_${createHash('sha256').update(`${ownerId}\0${candidateId}\0${fingerprint}`).digest('hex')}`;
}

function approvedMemory(candidate: MemoryImportCandidate, reviewerId: string, now: number): Memory {
  return {
    ...candidate,
    reviewStatus: 'approved',
    reviewedAt: new Date(now).toISOString(),
    reviewedBy: reviewerId,
  };
}

function validReason(reason: string): string {
  const value = reason.trim();
  if (!value || value.length > 2048) throw new DomainError('invalid_review_reason', 'Review reason must contain 1 to 2048 characters');
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
