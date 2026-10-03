import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetLedger } from '../src/agents/budget-ledger.js';
import { SqliteStore } from '../src/storage/sqlite.js';

test('shared budget reservations use CAS and charges are idempotent', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'budget', 'root-task', { maxCalls: 2, maxTokens: 100 });
    const attempts = await Promise.allSettled([
      ledger.reserve('owner', 'budget', 'child-a:model-1', { calls: 1, tokens: 70 }),
      ledger.reserve('owner', 'budget', 'child-b:model-1', { calls: 1, tokens: 70 }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    const accepted = attempts[0]?.status === 'fulfilled' ? 'child-a:model-1' : 'child-b:model-1';
    const charged = await ledger.charge('owner', 'budget', accepted, { calls: 1, tokens: 60 });
    assert.deepEqual(charged.used, { calls: 1, tokens: 60 });
    assert.deepEqual((await ledger.charge('owner', 'budget', accepted, { calls: 1, tokens: 60 })).used, { calls: 1, tokens: 60 });
    await assert.rejects(
      ledger.charge('owner', 'budget', accepted, { calls: 1, tokens: 61 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'idempotency_conflict',
    );
    await ledger.reserve('owner', 'budget', 'aggregate:model-1', { calls: 1, tokens: 40 });
    const complete = await ledger.charge('owner', 'budget', 'aggregate:model-1', { calls: 1, tokens: 40 });
    assert.deepEqual(complete.remaining, { calls: 0, tokens: 0 });
    await assert.rejects(
      ledger.reserve('owner', 'budget', 'extra', { calls: 1, tokens: 1 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget_exceeded',
    );
  } finally {
    await store.close();
  }
});

test('runtime event helpers charge cumulative usage deltas in order', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'runtime-budget', 'root-task', { maxCalls: 3, maxTokens: 100 });
    await ledger.reserveModelCall('owner', 'runtime-budget', 'child', 1, 40);
    assert.deepEqual(
      (await ledger.chargeModelUsage('owner', 'runtime-budget', 'child', { calls: 1, totalTokens: 30 })).used,
      { calls: 1, tokens: 30 },
    );
    await ledger.reserveModelCall('owner', 'runtime-budget', 'child', 2, 50);
    assert.deepEqual(
      (await ledger.chargeModelUsage('owner', 'runtime-budget', 'child', { calls: 2, totalTokens: 70 })).used,
      { calls: 2, tokens: 70 },
    );
    assert.deepEqual(
      (await ledger.chargeModelUsage('owner', 'runtime-budget', 'child', { calls: 2, totalTokens: 70 })).used,
      { calls: 2, tokens: 70 },
    );
    await assert.rejects(
      ledger.chargeModelUsage('owner', 'runtime-budget', 'child', { calls: 3, totalTokens: 80 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'reservation_not_found',
    );
  } finally {
    await store.close();
  }
});

test('a provider overrun records actual usage and reports a budget violation', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'overrun-budget', 'root-task', { maxCalls: 1, maxTokens: 10 });
    await ledger.reserveModelCall('owner', 'overrun-budget', 'child', 1, 10);
    await assert.rejects(
      ledger.chargeModelUsage('owner', 'overrun-budget', 'child', { calls: 1, totalTokens: 12 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget_violation',
    );
    const snapshot = await ledger.get('owner', 'overrun-budget');
    assert.deepEqual(snapshot.used, { calls: 1, tokens: 12 });
    assert.deepEqual(snapshot.remaining, { calls: 0, tokens: 0 });
    assert.deepEqual(snapshot.reserved, { calls: 0, tokens: 0 });
  } finally {
    await store.close();
  }
});

test('parent usage adoption is monotonic, delta charged, bounded, and idempotent', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'adoption-budget', 'root-task', { maxCalls: 3, maxTokens: 15 });
    await ledger.reserve('owner', 'adoption-budget', 'child:model:1', { calls: 1, tokens: 5 });
    await assert.rejects(
      ledger.adoptRuntimeUsage('owner', 'adoption-budget', 'root-task', { calls: 1, totalTokens: 11 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget_exceeded',
    );
    assert.deepEqual((await ledger.get('owner', 'adoption-budget')).used, { calls: 0, tokens: 0 });
    await ledger.release('owner', 'adoption-budget', 'child:model:1');
    const adopted = await ledger.adoptRuntimeUsage('owner', 'adoption-budget', 'root-task', { calls: 1, totalTokens: 6 });
    assert.deepEqual(adopted.used, { calls: 1, tokens: 6 });
    assert.deepEqual(
      (await ledger.adoptRuntimeUsage('owner', 'adoption-budget', 'root-task', { calls: 1, totalTokens: 6 })).used,
      { calls: 1, tokens: 6 },
    );
    assert.deepEqual(
      (await ledger.adoptRuntimeUsage('owner', 'adoption-budget', 'root-task', { calls: 2, totalTokens: 9 })).used,
      { calls: 2, tokens: 9 },
    );
    await assert.rejects(
      ledger.adoptRuntimeUsage('owner', 'adoption-budget', 'root-task', { calls: 1, totalTokens: 8 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_usage_sequence',
    );
    await assert.rejects(
      ledger.adoptRuntimeUsage('owner', 'adoption-budget', 'root-task', { calls: 3, totalTokens: 16 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget_exceeded',
    );
    assert.deepEqual((await ledger.get('owner', 'adoption-budget')).used, { calls: 2, tokens: 9 });
  } finally {
    await store.close();
  }
});

test('one-call shared budget admits only one parallel model dispatch', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'race-budget', 'root-task', { maxCalls: 1, maxTokens: 10 });
    const attempts = await Promise.allSettled([
      ledger.reserveModelCall('owner', 'race-budget', 'child-a', 1, 5),
      ledger.reserveModelCall('owner', 'race-budget', 'child-b', 1, 5),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  } finally {
    await store.close();
  }
});

test('an unreported call keeps its full shared reservation while the next actual usage settles once', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'unreported-budget', 'root', { maxCalls: 3, maxTokens: 100 });
    await ledger.reserveModelCall('owner', 'unreported-budget', 'task', 1, 20);
    const unreported = await ledger.chargeModelUsage('owner', 'unreported-budget', 'task', {
      calls: 1, totalTokens: 0, accountedTokens: 20,
    });
    assert.deepEqual(unreported.used, { calls: 0, tokens: 0 });
    assert.deepEqual(unreported.reserved, { calls: 1, tokens: 20 });

    await ledger.reserveModelCall('owner', 'unreported-budget', 'task', 2, 20);
    const reported = await ledger.chargeModelUsage('owner', 'unreported-budget', 'task', {
      calls: 2, totalTokens: 7, accountedTokens: 27,
    });
    assert.deepEqual(reported.used, { calls: 1, tokens: 7 });
    assert.deepEqual(reported.reserved, { calls: 1, tokens: 20 });
    assert.deepEqual(reported.remaining, { calls: 1, tokens: 73 });
    assert.deepEqual(
      (await ledger.chargeModelUsage('owner', 'unreported-budget', 'task', {
        calls: 2, totalTokens: 7, accountedTokens: 27,
      })).used,
      { calls: 1, tokens: 7 },
    );
  } finally { await store.close(); }
});

test('reconciliation restores a missing reservation and later replaces it with actual usage', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'recovery-budget', 'root', { maxCalls: 2, maxTokens: 100 });
    const reserved = await ledger.reconcileModelUsage('owner', 'recovery-budget', 'task', {
      calls: 1, totalTokens: 0, accountedTokens: 30,
    });
    assert.deepEqual(reserved.used, { calls: 0, tokens: 0 });
    assert.deepEqual(reserved.reserved, { calls: 1, tokens: 30 });
    assert.deepEqual(
      (await ledger.reconcileModelUsage('owner', 'recovery-budget', 'task', {
        calls: 1, totalTokens: 0, accountedTokens: 30,
      })).reserved,
      { calls: 1, tokens: 30 },
    );

    const settled = await ledger.reconcileModelUsage('owner', 'recovery-budget', 'task', {
      calls: 1, totalTokens: 11,
    });
    assert.deepEqual(settled.used, { calls: 1, tokens: 11 });
    assert.deepEqual(settled.reserved, { calls: 0, tokens: 0 });
    assert.deepEqual(
      (await ledger.reconcileModelUsage('owner', 'recovery-budget', 'task', {
        calls: 1, totalTokens: 11,
      })).used,
      { calls: 1, tokens: 11 },
    );
  } finally { await store.close(); }
});

test('reconciliation rejects accounting that does not match retained reservations', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'accounting-budget', 'root', { maxCalls: 2, maxTokens: 100 });
    await ledger.reserveModelCall('owner', 'accounting-budget', 'task', 1, 20);
    await assert.rejects(
      ledger.reconcileModelUsage('owner', 'accounting-budget', 'task', {
        calls: 1, totalTokens: 0, accountedTokens: 19,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_usage_sequence',
    );
    await ledger.reconcileModelUsage('owner', 'accounting-budget', 'task', {
      calls: 1, totalTokens: 0, accountedTokens: 20,
    });
    await assert.rejects(
      ledger.reconcileModelUsage('owner', 'accounting-budget', 'task', {
        calls: 1, totalTokens: 7, accountedTokens: 8,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_usage_sequence',
    );
    assert.deepEqual((await ledger.get('owner', 'accounting-budget')).used, { calls: 0, tokens: 0 });
  } finally { await store.close(); }
});

test('actual usage above one reservation is accepted unless the shared cumulative budget is exceeded', async () => {
  const store = new SqliteStore();
  const ledger = new BudgetLedger(store);
  try {
    await ledger.create('owner', 'elastic-budget', 'root', { maxCalls: 3, maxTokens: 100 });
    await ledger.reserveModelCall('owner', 'elastic-budget', 'other', 1, 20);
    await ledger.reserveModelCall('owner', 'elastic-budget', 'task', 1, 10);
    const accepted = await ledger.chargeModelUsage('owner', 'elastic-budget', 'task', {
      calls: 1, totalTokens: 50,
    });
    assert.deepEqual(accepted.used, { calls: 1, tokens: 50 });
    assert.deepEqual(accepted.reserved, { calls: 1, tokens: 20 });

    await ledger.reserveModelCall('owner', 'elastic-budget', 'task', 2, 10);
    await assert.rejects(
      ledger.chargeModelUsage('owner', 'elastic-budget', 'task', { calls: 2, totalTokens: 90 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget_violation',
    );
    const violated = await ledger.get('owner', 'elastic-budget');
    assert.deepEqual(violated.used, { calls: 2, tokens: 90 });
    assert.deepEqual(violated.reserved, { calls: 1, tokens: 20 });
  } finally { await store.close(); }
});
