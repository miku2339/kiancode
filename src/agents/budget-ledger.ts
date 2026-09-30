import { DomainError } from '../contracts.js';
import type { Entity, Store } from '../storage/store.js';

export interface BudgetUnits {
  calls: number;
  tokens: number;
}

export interface BudgetLimits {
  maxCalls: number;
  maxTokens: number;
}

export interface BudgetReservation {
  requested: BudgetUnits;
  state: 'reserved' | 'charged' | 'released';
  charged?: BudgetUnits;
  violation?: 'budget_violation';
}

export interface BudgetLedgerRecord {
  rootTaskId: string;
  limits: BudgetLimits;
  used: BudgetUnits;
  reservations: Record<string, BudgetReservation>;
  runtimeUsage: Record<string, BudgetUnits>;
}

export interface BudgetSnapshot {
  id: string;
  revision: number;
  rootTaskId: string;
  limits: BudgetLimits;
  used: BudgetUnits;
  reserved: BudgetUnits;
  remaining: BudgetUnits;
}

const zero = (): BudgetUnits => ({ calls: 0, tokens: 0 });

function validateUnits(units: BudgetUnits, allowZero = true): void {
  for (const [name, value] of Object.entries(units)) {
    if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
      throw new DomainError('invalid_budget', `${name} must be a non-negative safe integer`);
    }
  }
}

function validateLimits(limits: BudgetLimits): void {
  if (!Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 1
    || !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 1) {
    throw new DomainError('invalid_budget', 'Budget limits must be positive safe integers');
  }
}

function sameUnits(left: BudgetUnits, right: BudgetUnits): boolean {
  return left.calls === right.calls && left.tokens === right.tokens;
}

function reserved(record: BudgetLedgerRecord, except?: string): BudgetUnits {
  return Object.entries(record.reservations).reduce((total, [id, reservation]) => {
    if (id === except || reservation.state !== 'reserved') return total;
    total.calls += reservation.requested.calls;
    total.tokens += reservation.requested.tokens;
    return total;
  }, zero());
}

export class BudgetLedger {
  public constructor(private readonly store: Store) {}

  public async create(
    ownerId: string,
    id: string,
    rootTaskId: string,
    limits: BudgetLimits,
  ): Promise<Entity<BudgetLedgerRecord>> {
    validateLimits(limits);
    const existing = await this.store.get<BudgetLedgerRecord>('agent_budget', id, ownerId);
    if (existing) {
      if (existing.data.rootTaskId !== rootTaskId
        || existing.data.limits.maxCalls !== limits.maxCalls
        || existing.data.limits.maxTokens !== limits.maxTokens) {
        throw new DomainError('idempotency_conflict', 'Budget ID belongs to different limits', 409);
      }
      return existing;
    }
    try {
      return await this.store.create('agent_budget', ownerId, {
        rootTaskId,
        limits,
        used: zero(),
        reservations: {},
        runtimeUsage: {},
      }, id);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') {
        return this.create(ownerId, id, rootTaskId, limits);
      }
      throw error;
    }
  }

  public async reserve(
    ownerId: string,
    id: string,
    reservationId: string,
    requested: BudgetUnits,
  ): Promise<BudgetSnapshot> {
    validateUnits(requested);
    return this.change(ownerId, id, (record) => {
      const previous = record.reservations[reservationId];
      if (previous) {
        if (!sameUnits(previous.requested, requested)) {
          throw new DomainError('idempotency_conflict', 'Reservation ID belongs to different units', 409);
        }
        return record;
      }
      const held = reserved(record);
      if (record.used.calls + held.calls + requested.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + requested.tokens > record.limits.maxTokens) {
        throw new DomainError('budget_exceeded', 'Shared orchestration budget is exhausted', 409);
      }
      return {
        ...record,
        reservations: {
          ...record.reservations,
          [reservationId]: { requested, state: 'reserved' },
        },
      };
    });
  }

  public async charge(
    ownerId: string,
    id: string,
    reservationId: string,
    charged: BudgetUnits,
  ): Promise<BudgetSnapshot> {
    validateUnits(charged);
    return this.change(ownerId, id, (record) => {
      const previous = record.reservations[reservationId];
      if (!previous) throw new DomainError('reservation_not_found', 'Budget reservation not found', 404);
      if (previous.state === 'charged') {
        if (!previous.charged || !sameUnits(previous.charged, charged)) {
          throw new DomainError('idempotency_conflict', 'Reservation was charged with different usage', 409);
        }
        return record;
      }
      if (previous.state === 'released') {
        throw new DomainError('reservation_released', 'Budget reservation was released', 409);
      }
      const held = reserved(record, reservationId);
      if (record.used.calls + held.calls + charged.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + charged.tokens > record.limits.maxTokens) {
        throw new DomainError('budget_exceeded', 'Reported usage exceeds the shared orchestration budget', 409);
      }
      return {
        ...record,
        used: {
          calls: record.used.calls + charged.calls,
          tokens: record.used.tokens + charged.tokens,
        },
        reservations: {
          ...record.reservations,
          [reservationId]: { ...previous, state: 'charged', charged },
        },
      };
    });
  }

  public async release(ownerId: string, id: string, reservationId: string): Promise<BudgetSnapshot> {
    return this.change(ownerId, id, (record) => {
      const previous = record.reservations[reservationId];
      if (!previous || previous.state === 'released') return record;
      if (previous.state === 'charged') {
        throw new DomainError('reservation_charged', 'Charged usage cannot be released', 409);
      }
      return {
        ...record,
        reservations: {
          ...record.reservations,
          [reservationId]: { ...previous, state: 'released' },
        },
      };
    });
  }

  public async reserveModelCall(
    ownerId: string,
    id: string,
    taskId: string,
    call: number,
    tokenReservation = 0,
  ): Promise<BudgetSnapshot> {
    if (!Number.isSafeInteger(call) || call < 1) {
      throw new DomainError('invalid_usage', 'Model call number must be a positive safe integer');
    }
    return this.reserve(ownerId, id, `${taskId}:model:${call}`, { calls: 1, tokens: tokenReservation });
  }

  public async chargeModelUsage(
    ownerId: string,
    id: string,
    taskId: string,
    usage: { calls: number; totalTokens: number },
  ): Promise<BudgetSnapshot> {
    validateUnits({ calls: usage.calls, tokens: usage.totalTokens });
    if (usage.calls < 1) throw new DomainError('invalid_usage', 'Runtime usage must include a model call');
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<BudgetLedgerRecord>('agent_budget', id, ownerId);
      if (!row) throw new DomainError('not_found', 'Budget ledger not found', 404);
      const record = row.data;
      const cursors = record.runtimeUsage ?? {};
      const previousUsage = cursors[taskId] ?? zero();
      if (sameUnits(previousUsage, { calls: usage.calls, tokens: usage.totalTokens })) {
        const settled = record.reservations[`${taskId}:model:${usage.calls}`];
        if (settled?.violation) throw new DomainError('budget_violation', 'Provider usage exceeded its reserved shared budget', 409);
        return this.snapshot(row);
      }
      if (usage.calls !== previousUsage.calls + 1 || usage.totalTokens < previousUsage.tokens) {
        throw new DomainError('invalid_usage_sequence', 'Runtime usage events must be charged in order', 409);
      }
      const reservationId = `${taskId}:model:${usage.calls}`;
      const reservation = record.reservations[reservationId];
      if (!reservation) throw new DomainError('reservation_not_found', 'Model call was not reserved', 404);
      if (reservation.state !== 'reserved') {
        throw new DomainError('idempotency_conflict', 'Model call reservation was already settled with different usage', 409);
      }
      const charged = { calls: 1, tokens: usage.totalTokens - previousUsage.tokens };
      const held = reserved(record, reservationId);
      const violation = charged.calls > reservation.requested.calls
        || charged.tokens > reservation.requested.tokens
        || record.used.calls + held.calls + charged.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + charged.tokens > record.limits.maxTokens;
      const next: BudgetLedgerRecord = {
        ...record,
        used: {
          calls: record.used.calls + charged.calls,
          tokens: record.used.tokens + charged.tokens,
        },
        reservations: {
          ...record.reservations,
          [reservationId]: { ...reservation, state: 'charged', charged, ...(violation ? { violation: 'budget_violation' as const } : {}) },
        },
        runtimeUsage: {
          ...cursors,
          [taskId]: { calls: usage.calls, tokens: usage.totalTokens },
        },
      };
      try {
        const saved = await this.store.put('agent_budget', id, ownerId, next, row.revision);
        if (violation) throw new DomainError('budget_violation', 'Provider usage exceeded its reserved shared budget', 409);
        return this.snapshot(saved);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Budget ledger is busy; retry', 409);
  }

  public async adoptRuntimeUsage(
    ownerId: string,
    id: string,
    taskId: string,
    usage: { calls: number; totalTokens: number },
  ): Promise<BudgetSnapshot> {
    validateUnits({ calls: usage.calls, tokens: usage.totalTokens });
    return this.change(ownerId, id, (record) => {
      const cursors = record.runtimeUsage ?? {};
      const previous = cursors[taskId];
      const current = { calls: usage.calls, tokens: usage.totalTokens };
      if (previous && sameUnits(previous, current)) return record;
      if (previous && (current.calls < previous.calls || current.tokens < previous.tokens)) {
        throw new DomainError('invalid_usage_sequence', 'Adopted runtime usage cannot decrease', 409);
      }
      const delta = previous
        ? { calls: current.calls - previous.calls, tokens: current.tokens - previous.tokens }
        : current;
      const held = reserved(record);
      if (record.used.calls + held.calls + delta.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + delta.tokens > record.limits.maxTokens) {
        throw new DomainError('budget_exceeded', 'Existing parent usage exhausts the shared orchestration budget', 409);
      }
      return {
        ...record,
        used: {
          calls: record.used.calls + delta.calls,
          tokens: record.used.tokens + delta.tokens,
        },
        runtimeUsage: {
          ...cursors,
          [taskId]: current,
        },
      };
    });
  }

  public async get(ownerId: string, id: string): Promise<BudgetSnapshot> {
    const row = await this.store.get<BudgetLedgerRecord>('agent_budget', id, ownerId);
    if (!row) throw new DomainError('not_found', 'Budget ledger not found', 404);
    return this.snapshot(row);
  }

  private async change(
    ownerId: string,
    id: string,
    mutate: (record: BudgetLedgerRecord) => BudgetLedgerRecord,
  ): Promise<BudgetSnapshot> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<BudgetLedgerRecord>('agent_budget', id, ownerId);
      if (!row) throw new DomainError('not_found', 'Budget ledger not found', 404);
      const next = mutate(row.data);
      if (next === row.data) return this.snapshot(row);
      try {
        return this.snapshot(await this.store.put('agent_budget', id, ownerId, next, row.revision));
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Budget ledger is busy; retry', 409);
  }

  private snapshot(row: Entity<BudgetLedgerRecord>): BudgetSnapshot {
    const held = reserved(row.data);
    return {
      id: row.id,
      revision: row.revision,
      rootTaskId: row.data.rootTaskId,
      limits: row.data.limits,
      used: row.data.used,
      reserved: held,
      remaining: {
        calls: Math.max(0, row.data.limits.maxCalls - row.data.used.calls - held.calls),
        tokens: Math.max(0, row.data.limits.maxTokens - row.data.used.tokens - held.tokens),
      },
    };
  }
}
