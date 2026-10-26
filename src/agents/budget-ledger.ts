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

function taskReservedTokens(record: BudgetLedgerRecord, taskId: string, except?: string): number {
  const prefix = `${taskId}:model:`;
  return Object.entries(record.reservations).reduce((tokens, [id, reservation]) => (
    id !== except && id.startsWith(prefix) && reservation.state === 'reserved'
      ? tokens + reservation.requested.tokens
      : tokens
  ), 0);
}

function delegationExceeded(
  record: BudgetLedgerRecord,
  held: BudgetUnits,
  requested: BudgetUnits,
  code: 'budget_exceeded' | 'budget_violation',
): DomainError {
  if (record.used.calls + held.calls + requested.calls > record.limits.maxCalls) {
    return new DomainError(
      code,
      `Delegation model call budget exhausted: limit ${record.limits.maxCalls}, used ${record.used.calls}, reserved ${held.calls}, requested ${requested.calls}.`,
      409,
    );
  }
  return new DomainError(
    code,
    `Delegation token budget exhausted: limit ${record.limits.maxTokens}, used ${record.used.tokens}, reserved ${held.tokens}, requested ${requested.tokens}.`,
    409,
  );
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
        throw delegationExceeded(record, held, requested, 'budget_exceeded');
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
    const reservationId = `${taskId}:model:${call}`;
    const requested = { calls: 1, tokens: tokenReservation };
    validateUnits(requested);
    return this.change(ownerId, id, (record) => {
      const previous = record.reservations[reservationId];
      if (previous && previous.state !== 'released' && !sameUnits(previous.requested, requested)) {
        throw new DomainError('idempotency_conflict', 'Reservation ID belongs to different units', 409);
      }
      if (previous && previous.state !== 'released') return record;
      const held = reserved(record);
      if (record.used.calls + held.calls + requested.calls > record.limits.maxCalls
        || record.used.tokens + held.tokens + requested.tokens > record.limits.maxTokens) {
        throw delegationExceeded(record, held, requested, 'budget_exceeded');
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

  public async releaseModelCall(
    ownerId: string,
    id: string,
    taskId: string,
    call: number,
  ): Promise<BudgetSnapshot> {
    if (!Number.isSafeInteger(call) || call < 1) {
      throw new DomainError('invalid_usage', 'Model call number must be a positive safe integer');
    }
    const reservationId = `${taskId}:model:${call}`;
    return this.change(ownerId, id, (record) => {
      const previous = record.reservations[reservationId];
      if (!previous) return record;
      if (previous.state === 'charged') {
        throw new DomainError('reservation_charged', 'Charged usage cannot be released', 409);
      }
      const cursors = record.runtimeUsage ?? {};
      const cursor = cursors[taskId] ?? zero();
      if (cursor.calls !== call && cursor.calls !== call - 1) {
        throw new DomainError('invalid_usage_sequence', 'Released model call does not match runtime usage', 409);
      }
      const runtimeUsage = cursor.calls === call
        ? { ...cursors, [taskId]: { calls: call - 1, tokens: cursor.tokens } }
        : cursors;
      if (previous.state === 'released' && runtimeUsage === cursors) return record;
      return {
        ...record,
        reservations: {
          ...record.reservations,
          [reservationId]: { ...previous, state: 'released' },
        },
        runtimeUsage,
      };
    });
  }

  public async chargeModelUsage(
    ownerId: string,
    id: string,
    taskId: string,
    usage: { calls: number; totalTokens: number; accountedTokens?: number },
  ): Promise<BudgetSnapshot> {
    validateUnits({ calls: usage.calls, tokens: usage.totalTokens });
    if (usage.accountedTokens !== undefined) {
      validateUnits({ calls: 0, tokens: usage.accountedTokens });
      if (usage.accountedTokens < usage.totalTokens) {
        throw new DomainError('invalid_usage', 'Accounted tokens cannot be below reported tokens');
      }
    }
    if (usage.calls < 1) throw new DomainError('invalid_usage', 'Runtime usage must include a model call');
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<BudgetLedgerRecord>('agent_budget', id, ownerId);
      if (!row) throw new DomainError('not_found', 'Budget ledger not found', 404);
      const record = row.data;
      const cursors = record.runtimeUsage ?? {};
      const previousUsage = cursors[taskId] ?? zero();
      if (usage.calls < previousUsage.calls && usage.totalTokens <= previousUsage.tokens) {
        const historical = record.reservations[`${taskId}:model:${usage.calls}`];
        if (historical?.violation) throw delegationExceeded(record, reserved(record), zero(), 'budget_violation');
        return this.snapshot(row);
      }
      if (usage.calls === previousUsage.calls && usage.totalTokens === previousUsage.tokens) {
        const settled = record.reservations[`${taskId}:model:${usage.calls}`];
        if (settled?.violation) throw delegationExceeded(record, reserved(record), zero(), 'budget_violation');
        return this.snapshot(row);
      }
      const currentCall = usage.calls === previousUsage.calls;
      if ((!currentCall && usage.calls !== previousUsage.calls + 1)
        || usage.totalTokens < previousUsage.tokens
        || (currentCall && usage.totalTokens === previousUsage.tokens)) {
        throw new DomainError('invalid_usage_sequence', 'Runtime usage events must be charged in order', 409);
      }
      const reservationId = `${taskId}:model:${usage.calls}`;
      const reservation = record.reservations[reservationId];
      if (!reservation) throw new DomainError('reservation_not_found', 'Model call was not reserved', 404);
      if (reservation.state !== 'reserved') {
        throw new DomainError('idempotency_conflict', 'Model call reservation was already settled with different usage', 409);
      }
      const charged = { calls: 1, tokens: usage.totalTokens - previousUsage.tokens };
      if (charged.tokens === 0) {
        const next: BudgetLedgerRecord = {
          ...record,
          runtimeUsage: {
            ...cursors,
            [taskId]: { calls: usage.calls, tokens: usage.totalTokens },
          },
        };
        try {
          const saved = await this.store.put('agent_budget', id, ownerId, next, row.revision);
          if (reservation.violation) throw delegationExceeded(next, reserved(next), zero(), 'budget_violation');
          return this.snapshot(saved);
        } catch (error) {
          if (error instanceof DomainError && error.code === 'conflict') continue;
          throw error;
        }
      }
      const held = reserved(record, reservationId);
      const violation = charged.calls > reservation.requested.calls
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
        if (violation) throw delegationExceeded(next, reserved(next), zero(), 'budget_violation');
        return this.snapshot(saved);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Budget ledger is busy; retry', 409);
  }

  public async reconcileModelUsage(
    ownerId: string,
    id: string,
    taskId: string,
    usage: { calls: number; totalTokens: number; accountedTokens?: number },
  ): Promise<BudgetSnapshot> {
    validateUnits({ calls: usage.calls, tokens: usage.totalTokens });
    const accountedTokens = usage.accountedTokens ?? usage.totalTokens;
    validateUnits({ calls: 0, tokens: accountedTokens });
    if (usage.calls < 1 || accountedTokens < usage.totalTokens) {
      throw new DomainError('invalid_usage', 'Runtime usage is invalid');
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<BudgetLedgerRecord>('agent_budget', id, ownerId);
      if (!row) throw new DomainError('not_found', 'Budget ledger not found', 404);
      const record = row.data;
      const cursors = record.runtimeUsage ?? {};
      const previous = cursors[taskId] ?? zero();
      if (usage.calls < previous.calls && usage.totalTokens <= previous.tokens) {
        const historical = record.reservations[`${taskId}:model:${usage.calls}`];
        if (historical?.violation) throw delegationExceeded(record, reserved(record), zero(), 'budget_violation');
        return this.snapshot(row);
      }
      if (usage.calls === previous.calls && usage.totalTokens < previous.tokens
        && record.reservations[`${taskId}:model:${usage.calls}`]) {
        return this.snapshot(row);
      }
      if (usage.calls < previous.calls || usage.totalTokens < previous.tokens
        || usage.calls > previous.calls + 1) {
        throw new DomainError('invalid_usage_sequence', 'Runtime usage cannot be uniquely reconciled', 409);
      }
      if (usage.calls === previous.calls) {
        const reservationId = `${taskId}:model:${usage.calls}`;
        const reservation = record.reservations[reservationId];
        if (usage.totalTokens === previous.tokens) {
          if (accountedTokens - usage.totalTokens !== taskReservedTokens(record, taskId)) {
            throw new DomainError('invalid_usage_sequence', 'Accounted tokens do not match retained model reservations', 409);
          }
          if (reservation?.violation) throw delegationExceeded(record, reserved(record), zero(), 'budget_violation');
          return this.snapshot(row);
        }
        if (!reservation || reservation.state !== 'reserved'
          || accountedTokens - usage.totalTokens !== taskReservedTokens(record, taskId, reservationId)) {
          throw new DomainError('invalid_usage_sequence', 'Reported usage does not match retained model reservations', 409);
        }
        return this.chargeModelUsage(ownerId, id, taskId, usage);
      }

      const reservationId = `${taskId}:model:${usage.calls}`;
      let reservation = record.reservations[reservationId];
      let next = record;
      let violation = reservation?.violation === 'budget_violation';
      if (!reservation) {
        const taskHeld = taskReservedTokens(record, taskId);
        const requestedTokens = accountedTokens - usage.totalTokens - taskHeld;
        if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1) {
          throw new DomainError('invalid_usage_sequence', 'Missing model reservation cannot be reconstructed', 409);
        }
        const held = reserved(record);
        violation = record.used.calls + held.calls + 1 > record.limits.maxCalls
          || record.used.tokens + held.tokens + requestedTokens > record.limits.maxTokens;
        reservation = {
          requested: { calls: 1, tokens: requestedTokens },
          state: 'reserved',
          ...(violation ? { violation: 'budget_violation' as const } : {}),
        };
        next = {
          ...record,
          reservations: { ...record.reservations, [reservationId]: reservation },
        };
      } else if (reservation.state === 'released') {
        const taskHeld = taskReservedTokens(record, taskId);
        const requestedTokens = accountedTokens - usage.totalTokens - taskHeld;
        if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1) {
          throw new DomainError('invalid_usage_sequence', 'Released model reservation does not match runtime usage', 409);
        }
        const requested = { calls: 1, tokens: requestedTokens };
        const held = reserved(record);
        violation = record.used.calls + held.calls + requested.calls > record.limits.maxCalls
          || record.used.tokens + held.tokens + requested.tokens > record.limits.maxTokens;
        reservation = {
          requested,
          state: 'reserved',
          ...(violation ? { violation: 'budget_violation' as const } : {}),
        };
        next = {
          ...record,
          reservations: { ...record.reservations, [reservationId]: reservation },
        };
      } else if (reservation.state !== 'reserved') {
        throw new DomainError('idempotency_conflict', 'Model call reservation was already settled with different usage', 409);
      }
      const expectedHeld = usage.totalTokens > previous.tokens
        ? taskReservedTokens(next, taskId, reservationId)
        : taskReservedTokens(next, taskId);
      if (accountedTokens - usage.totalTokens !== expectedHeld) {
        throw new DomainError('invalid_usage_sequence', 'Accounted tokens do not match retained model reservations', 409);
      }
      next = {
        ...next,
        runtimeUsage: {
          ...(next.runtimeUsage ?? {}),
          [taskId]: { calls: usage.calls, tokens: previous.tokens },
        },
      };
      try {
        const saved = await this.store.put('agent_budget', id, ownerId, next, row.revision);
        if (violation) throw delegationExceeded(next, reserved(next), zero(), 'budget_violation');
        if (usage.totalTokens > previous.tokens) {
          return this.chargeModelUsage(ownerId, id, taskId, usage);
        }
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
