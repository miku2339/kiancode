import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccessService, type AccessGrant, type LevelCeilings } from '../src/access.js';
import { accountAuth } from '../src/auth.js';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { AutomationDispatcher, EventTriggerService, type EventInboxItem } from '../src/event-triggers.js';
import { createServer } from '../src/http/server.js';
import { NotificationService } from '../src/notifications.js';
import { SchedulerService, type AutomationSchedule, type ScheduleOccurrence } from '../src/scheduler.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';

const issuer = 'https://identity.example.test';
const ownerSubject = `acct_${'a'.repeat(32)}`;
const memberSubject = `acct_${'b'.repeat(32)}`;
const serviceToken = 'service-token';
const conversation: Conversation = {
  title: 'Access', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
};

function principalId(subject: string): string {
  return createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
}

async function accountIdentity(
  subject: string,
  level: Principal['level'] = 2,
  scopes: string[] = [],
): Promise<Principal> {
  const authenticate = accountAuth(issuer, (async () => Response.json({
    success: true,
    data: { session: {
      subject,
      level,
      scopes,
      expiresAt: Math.floor(Date.now() / 1_000) + 600,
      applicationId: 'kiancode',
      audience: 'kiancode',
      credentialVersion: 1,
      consentVersion: 1,
    } },
  })) as typeof fetch, 'kiancode');
  return authenticate('Bearer credential');
}

function identity(subject: string, level: Principal['level'] = 2, overrides: Partial<Principal> = {}): Principal {
  return {
    id: principalId(subject),
    issuer,
    subject,
    level,
    scopes: [],
    applicationId: 'kiancode',
    audience: 'kiancode',
    credentialVersion: 1,
    consentVersion: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function hasCode(expected: string, statusCode?: number): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === expected
    && (statusCode === undefined || error.statusCode === statusCode);
}

async function storeRecord(store: Store, subject: string, scopes: string[], enabled = true): Promise<void> {
  const id = principalId(subject);
  await store.create<AccessGrant>('access', id, { scopes, enabled }, id);
}

function accountAccess(store: Store, levelCeilings: LevelCeilings = {}): AccessService {
  const authorizationCheck = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { credentialVersion: number; consentVersion: number };
    return Response.json({ success: true, data: { active: true, credentialVersion: body.credentialVersion, consentVersion: body.consentVersion } });
  }) as typeof fetch;
  return new AccessService(store, ownerSubject, serviceToken, 'account', undefined, authorizationCheck, levelCeilings);
}

function accountSessionAuth(sessions: Record<string, { subject: string; level: Principal['level']; scopes?: string[] }>) {
  return accountAuth(issuer, (async (_input: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    const session = sessions[bearer];
    if (!session) return new Response(null, { status: 401 });
    return Response.json({ success: true, data: { session: {
      ...session,
      scopes: session.scopes ?? [],
      expiresAt: Math.floor(Date.now() / 1_000) + 600,
      applicationId: 'kiancode',
      audience: 'kiancode',
      credentialVersion: 1,
      consentVersion: 1,
    } } });
  }) as typeof fetch, 'kiancode');
}

async function accessServer(
  store: SqliteStore,
  access: AccessService,
  sessions: Record<string, { subject: string; level: Principal['level']; scopes?: string[] }>,
) {
  const authenticateIdentity = accountSessionAuth(sessions);
  return createServer({
    store,
    access,
    authenticate: async (authorization) => access.authorize(await authenticateIdentity(authorization)),
    runner: async () => ({ text: 'unused' }),
  });
}

function putAccess(
  server: Awaited<ReturnType<typeof accessServer>>,
  bearer: string,
  id: string,
  payload: unknown,
) {
  return server.app.inject({
    method: 'PUT',
    url: `/v1/access/${encodeURIComponent(id)}`,
    headers: { authorization: `Bearer ${bearer}` },
    payload: payload as object,
  });
}

function reauthorizeWith(access: AccessService): (principal: Principal) => Promise<Principal> {
  return async (principal) => {
    if (!await access.validateDelegation(principal)) {
      throw new DomainError('grant_revoked', 'Task authorization has expired or been revoked', 403);
    }
    return access.authorize(principal);
  };
}

test('the configured owner is admitted before any legacy self-record lookup', async () => {
  const store = new SqliteStore();
  try {
    await storeRecord(store, ownerSubject, ['chat:read'], false);
    let reads = 0;
    const counting = Object.assign(Object.create(store) as Store, {
      get: async <T>(kind: string, id: string, ownerId: string) => {
        reads += 1;
        return store.get<T>(kind, id, ownerId);
      },
    });
    const owner = await new AccessService(counting, ownerSubject, serviceToken, 'account')
      .authorize(await accountIdentity(ownerSubject, 5, ['chat:read']));
    assert.equal(reads, 0);
    assert.equal(owner.level, 1);
    assert.deepEqual(owner.scopes, ['*']);
    assert.deepEqual((await store.get<AccessGrant>('access', owner.id, owner.id))?.data, {
      scopes: ['chat:read'], enabled: false,
    });
  } finally {
    await store.close();
  }
});

test('account and OIDC principals require an enabled explicit grant and do not trust identity scopes', async () => {
  const store = new SqliteStore();
  try {
    for (const mode of ['account', 'oidc'] as const) {
      const access = new AccessService(store, ownerSubject, serviceToken, mode);
      await assert.rejects(
        access.authorize(identity(memberSubject, 1, { scopes: ['*', 'admin:grant'] })),
        hasCode('access_required', 403),
      );
      await assert.rejects(
        access.authorize({ id: 'missing-identity', level: 1, scopes: ['*'] }),
        hasCode('access_required', 403),
      );
    }

    await storeRecord(store, memberSubject, ['chat:read']);
    const access = accountAccess(store);
    const member = await access.authorize(identity(memberSubject, 1, { scopes: ['*'] }));
    assert.equal(member.level, 2);
    assert.deepEqual(member.scopes, ['chat:read']);

    const record = await store.get<AccessGrant>('access', member.id, member.id);
    assert.ok(record);
    await store.put<AccessGrant>('access', member.id, member.id, { scopes: ['chat:read'], enabled: false }, record.revision);
    await assert.rejects(access.authorize(identity(memberSubject)), hasCode('access_revoked', 403));
  } finally {
    await store.close();
  }
});

test('development mode returns the identity unchanged without reading access records', async () => {
  const store = new SqliteStore();
  try {
    let reads = 0;
    const counting = Object.assign(Object.create(store) as Store, {
      get: async <T>(kind: string, id: string, ownerId: string) => {
        reads += 1;
        return store.get<T>(kind, id, ownerId);
      },
    });
    const access = new AccessService(counting, undefined, undefined, 'development');
    const local: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
    assert.equal(await access.authorize(local), local);
    const signedIn = identity(memberSubject, 3, { scopes: ['chat:read'] });
    assert.equal(await access.authorize(signedIn), signedIn);
    assert.equal(reads, 0);
  } finally {
    await store.close();
  }
});

const conversationalCeiling = [
  'chat:read', 'chat:write', 'task:read', 'task:write', 'memory:read', 'memory:write',
  'agent:read', 'agent:write', 'artifact:read', 'artifact:write', 'notification:read', 'notification:write',
  'model:read', 'workspace:read', 'device:read', 'approval:write', 'schedule:read',
];

async function effectiveScopes(
  recordScopes: string[],
  level: Principal['level'] = 2,
  levelCeilings: LevelCeilings = {},
): Promise<string[]> {
  const store = new SqliteStore();
  try {
    await storeRecord(store, memberSubject, recordScopes);
    return (await accountAccess(store, levelCeilings).authorize(identity(memberSubject, level))).scopes;
  } finally {
    await store.close();
  }
}

test('legacy wildcard, admin, and tool scopes are reduced to the level ceiling', async () => {
  const legacy = ['*', 'kiancode:*', 'admin:grant', 'shell:execute', 'schedule:write'];
  assert.deepEqual(await effectiveScopes(legacy), conversationalCeiling);
  assert.deepEqual(await effectiveScopes(['chat:*']), ['chat:read', 'chat:write']);
  assert.deepEqual(await effectiveScopes(['kiancode:chat:read']), ['chat:read']);
  assert.deepEqual(await effectiveScopes(['schedule:*']), ['schedule:read']);
});

test('empty effective access and level 5 are denied unless that level ceiling is configured', async () => {
  await assert.rejects(effectiveScopes(['shell:execute']), hasCode('access_required', 403));
  await assert.rejects(effectiveScopes(['chat:read'], 5), hasCode('access_required', 403));
  assert.deepEqual(await effectiveScopes(['chat:read', 'chat:write'], 5, { 5: ['chat:read'] }), ['chat:read']);
  assert.deepEqual(await effectiveScopes(['shell:execute'], 2, { 2: ['*'] }), ['shell:execute']);
});

test('validateDelegation uses the canonical wildcard matcher', async () => {
  const store = new SqliteStore();
  try {
    await storeRecord(store, memberSubject, ['chat:*']);
    const access = new AccessService(store, ownerSubject, undefined, 'oidc', undefined, fetch, { 2: ['chat:*'] });
    assert.equal(await access.validateDelegation({ ...identity(memberSubject), scopes: ['chat:read'] }), true);
    assert.equal(await access.validateDelegation({ ...identity(memberSubject), scopes: ['chat:read', 'shell:execute'] }), false);
  } finally {
    await store.close();
  }
});

test('account automation delegation validates its canonical identity tuple before access lookup', async () => {
  const store = new SqliteStore();
  let requests = 0;
  const fetcher = (async () => {
    requests += 1;
    return Response.json({ success: true, data: { active: true, credentialVersion: 1, consentVersion: 1 } });
  }) as typeof fetch;
  const access = new AccessService(
    store,
    ownerSubject,
    serviceToken,
    'account',
    undefined,
    fetcher,
    {},
    { expectedIssuer: `${issuer}/tenant?source=test`, expectedAudience: 'kiancode' },
  );
  const valid = identity(ownerSubject, 1, { applicationId: 'kiancode-plus' });
  try {
    assert.equal(await access.validateDelegation(valid), true);
    assert.equal(requests, 1);
    for (const changed of [
      { ...valid, id: principalId(memberSubject) },
      { ...valid, issuer: `${issuer}/path` },
      { ...valid, subject: memberSubject },
      { ...valid, audience: 'other' },
      { ...valid, audience: '' },
      { ...valid, applicationId: '' },
      { ...valid, credentialVersion: -1 },
      { ...valid, credentialVersion: 1.5 },
      { ...valid, consentVersion: 0 },
      { ...valid, consentVersion: 1.5 },
    ]) {
      await assert.rejects(access.validateDelegation(changed), hasCode('invalid_automation_identity', 403));
    }
    assert.equal(requests, 1);
  } finally {
    await store.close();
  }
});

test('account authorization outages remain retryable while explicit inactive or changed credentials are revoked', async () => {
  const store = new SqliteStore();
  const owner = identity(ownerSubject, 1);
  const accessFor = (fetcher: typeof fetch, token: string | undefined = serviceToken) => new AccessService(
    store, ownerSubject, token, 'account', undefined, fetcher, {},
    { expectedIssuer: issuer, expectedAudience: 'kiancode' },
  );
  try {
    for (const fetcher of [
      (async () => { throw new Error('offline'); }) as typeof fetch,
      (async () => new Response(null, { status: 401 })) as typeof fetch,
      (async () => new Response(null, { status: 503 })) as typeof fetch,
      (async () => new Response('{')) as typeof fetch,
      (async () => Response.json(null)) as typeof fetch,
      (async () => Response.json({ success: true, data: {} })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: true, credentialVersion: 1 } })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: true, credentialVersion: 1, consentVersion: 1.5 } })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: true, credentialVersion: 1, consentVersion: '1' } })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: false, credentialVersion: 0 } })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: false, credentialVersion: -1, consentVersion: 0 } })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: false, credentialVersion: 0, consentVersion: -1 } })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: false, credentialVersion: 0.5, consentVersion: 0 } })) as typeof fetch,
      (async () => Response.json({ success: true, data: { active: false, credentialVersion: 0, consentVersion: '0' } })) as typeof fetch,
    ]) {
      await assert.rejects(accessFor(fetcher).validateDelegation(owner), hasCode('identity_unavailable', 503));
    }
    await assert.rejects(accessFor(fetch, undefined).validateDelegation(owner), hasCode('identity_unavailable', 503));
    assert.equal(await accessFor((async () => Response.json({
      success: true, data: { active: false, credentialVersion: 0, consentVersion: 0 },
    })) as typeof fetch).validateDelegation(owner), false);
    assert.equal(await accessFor((async () => Response.json({
      success: true, data: { active: false, credentialVersion: 1, consentVersion: 1 },
    })) as typeof fetch).validateDelegation(owner), false);
    assert.equal(await accessFor((async () => Response.json({
      success: true, data: { active: true, credentialVersion: 0, consentVersion: 0 },
    })) as typeof fetch).validateDelegation(owner), false);
    assert.equal(await accessFor((async () => Response.json({
      success: true, data: { active: true, credentialVersion: 2, consentVersion: 1 },
    })) as typeof fetch).validateDelegation(owner), false);
    assert.equal(await accessFor((async () => Response.json({
      success: true, data: { active: true, credentialVersion: 1, consentVersion: 2 },
    })) as typeof fetch).validateDelegation(owner), false);
  } finally {
    await store.close();
  }
});

test('only the configured owner can grant a valid principal over HTTP', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store, { 2: ['*'] });
  await storeRecord(store, memberSubject, ['admin:grant', 'chat:read']);
  const server = await accessServer(store, access, {
    owner: { subject: ownerSubject, level: 5 },
    member: { subject: memberSubject, level: 1, scopes: ['*'] },
  });
  const targetSubject = `acct_${'c'.repeat(32)}`;
  const target = principalId(targetSubject);
  try {
    const denied = await putAccess(server, 'member', target, { scopes: ['chat:read'], enabled: true });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error.code, 'owner_required');
    assert.equal(await store.get('access', target, target), undefined);

    const granted = await putAccess(server, 'owner', target, { scopes: ['chat:read'], enabled: true });
    assert.equal(granted.statusCode, 200, granted.body);
    assert.deepEqual(granted.json().data.data, { scopes: ['chat:read'], enabled: true });
  } finally {
    await server.close();
  }
});

test('an owner grant admits the hashed member principal on the next request', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const server = await accessServer(store, access, {
    owner: { subject: ownerSubject, level: 4 },
    member: { subject: memberSubject, level: 1, scopes: ['*'] },
  });
  try {
    for (const url of ['/v1/session', '/v1/conversations', '/v1/tasks']) {
      const before = await server.app.inject({ method: 'GET', url, headers: { authorization: 'Bearer member' } });
      assert.equal(before.statusCode, 403, `${url}: ${before.body}`);
      assert.equal(before.json().error.code, 'access_required');
    }

    const granted = await putAccess(server, 'owner', principalId(memberSubject), { scopes: ['chat:read'], enabled: true });
    assert.equal(granted.statusCode, 200, granted.body);
    const after = await server.app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'Bearer member' } });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().data.level, 2);
    assert.deepEqual(after.json().data.scopes, ['chat:read']);
    assert.equal((await server.app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: 'Bearer member' },
    })).statusCode, 200);
    const outside = await server.app.inject({
      method: 'GET', url: '/v1/tasks', headers: { authorization: 'Bearer member' },
    });
    assert.equal(outside.statusCode, 403, outside.body);
    assert.equal(outside.json().error.code, 'forbidden');
  } finally {
    await server.close();
  }
});

test('grant rejects self, non-hash ids, reserved scopes, and malformed scopes without writing', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const server = await accessServer(store, access, { owner: { subject: ownerSubject, level: 1 } });
  const ownerId = principalId(ownerSubject);
  const target = principalId(memberSubject);
  try {
    for (const id of [ownerId, memberSubject, target.toUpperCase(), target.slice(1), `${target}0`]) {
      const response = await putAccess(server, 'owner', id, { scopes: ['chat:read'], enabled: true });
      assert.equal(response.statusCode, 400, `${id}: ${response.body}`);
      assert.equal(response.json().error.code, 'invalid_principal');
    }
    for (const scope of [
      '*', 'kiancode:*', 'admin:*', 'admin:grant', 'kiancode:admin:grant',
      ' ', 'chat: read', 'chat\tread', 'chat\0read', 'café:read', 'x'.repeat(101),
    ]) {
      const response = await putAccess(server, 'owner', target, { scopes: [scope], enabled: true });
      assert.equal(response.statusCode, 400, `${JSON.stringify(scope)}: ${response.body}`);
      assert.equal(response.json().error.code, scope.length > 100 ? 'invalid_input' : 'invalid_scope');
    }
    assert.equal((await store.scan('access')).length, 0);

    const accepted = await putAccess(server, 'owner', target, {
      scopes: ['mcp:MyPlugin', 'workspace:abc:read', 'chat:*'], enabled: true,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  } finally {
    await server.close();
  }
});

test('development grants allow local ids but still reject the owner own id', async () => {
  const store = new SqliteStore();
  try {
    const access = new AccessService(store, undefined, undefined, 'development');
    const local: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
    await assert.rejects(
      access.grant(local, local.id, { scopes: ['chat:read'], enabled: false }),
      hasCode('invalid_principal', 400),
    );
    const written = await access.grant(local, 'device-user', { scopes: ['chat:read'], enabled: true });
    assert.equal(written.id, 'device-user');
  } finally {
    await store.close();
  }
});

test('a task without an access record pauses and can resume after a grant', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  let runs = 0;
  const service = new TaskService(store, async () => { runs += 1; return { text: 'done' }; }, {
    reauthorize: reauthorizeWith(access),
    notifications: new NotificationService(store),
  });
  const member = identity(memberSubject, 2, { scopes: ['chat:read'] });
  try {
    const thread = await store.create<Conversation>('conversation', member.id, conversation);
    const task = await service.enqueue(member, thread.id, 'answer');
    await service.drain();
    const paused = await store.get<Task>('task', task.id, member.id);
    assert.equal(paused?.data.state, 'paused', paused?.data.error);
    assert.equal(paused?.data.pauseRequested, true);
    assert.equal(runs, 0);

    await storeRecord(store, memberSubject, ['chat:read']);
    await service.control(member.id, task.id, 'resume', [], await access.authorize(identity(memberSubject)));
    await service.drain();
    assert.equal((await store.get<Task>('task', task.id, member.id))?.data.state, 'completed');
    assert.equal(runs, 1);
  } finally {
    await service.close();
    await store.close();
  }
});

test('a schedule without current access is rejected and disabled', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const now = Date.now();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), {
    now: () => now,
    notifications: new NotificationService(store, { now: () => new Date(now) }),
  });
  const actor = identity(memberSubject, 1, { scopes: ['*'] });
  try {
    const thread = await store.create<Conversation>('conversation', actor.id, conversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => now), {
      enabled: true,
      now: () => now,
      reauthorize: reauthorizeWith(access),
    });
    const schedule = await scheduler.create(actor, {
      name: 'Stale actor',
      prompt: 'scheduled',
      nextAt: new Date(now - 1_000).toISOString(),
      enabled: true,
      settings: { conversationId: thread.id, permissions: ['model:read'], notification: { type: 'in_app' } },
    });
    await scheduler.reconcile();
    const occurrences = await store.scan<ScheduleOccurrence>('schedule_occurrence', actor.id);
    assert.equal(occurrences[0]?.data.status, 'rejected');
    assert.equal(occurrences[0]?.data.rejectionCode, 'access_required');
    const stored = await store.get<AutomationSchedule>('automation_schedule', schedule.id, actor.id);
    assert.equal(stored?.data.enabled, false);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('an event trigger without current access is rejected and disabled', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  const actor = identity(memberSubject, 1, { scopes: ['*'] });
  try {
    const thread = await store.create<Conversation>('conversation', actor.id, conversation);
    const triggers = new EventTriggerService(store, new AutomationDispatcher(store, tasks), {
      enabled: true,
      reauthorize: reauthorizeWith(access),
    });
    const created = await triggers.create(actor, {
      name: 'Stale actor', prompt: 'Never run', enabled: true, type: 'webhook', filter: {},
      settings: { conversationId: thread.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    await triggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, {
      eventId: 'stale-1', eventName: 'test', payload: {},
    });
    await triggers.reconcile();
    const inbox = await store.scan<EventInboxItem>('event_inbox', actor.id);
    assert.equal(inbox[0]?.data.status, 'rejected');
    assert.equal(inbox[0]?.data.rejectionCode, 'access_required');
    assert.equal((await triggers.list(actor.id))[0]?.data.enabled, false);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('bootstrap passes the configured owner and level ceilings into access decisions', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-access-'));
  const ownerEnv = 'KIANCODE_ACCESS_TEST_OWNER_SUBJECT';
  const previousOwner = process.env[ownerEnv];
  process.env[ownerEnv] = ownerSubject;
  const sessions: Record<string, { subject: string; level: Principal['level'] }> = {
    owner: { subject: ownerSubject, level: 4 },
    member: { subject: memberSubject, level: 1 },
    guest: { subject: `acct_${'c'.repeat(32)}`, level: 5 },
  };
  context.mock.method(globalThis, 'fetch', (async (_input: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    const session = sessions[bearer];
    if (!session) return new Response(null, { status: 401 });
    return Response.json({ success: true, data: { session: {
      ...session,
      scopes: ['*'],
      expiresAt: Math.floor(Date.now() / 1_000) + 600,
      applicationId: 'kiancode',
      audience: 'kiancode',
      credentialVersion: 1,
      consentVersion: 1,
    } } });
  }) as typeof fetch);
  let server: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    server = await bootstrap(configSchema.parse({
      stateDirectory: path.join(directory, 'state'),
      checkpointDirectory: path.join(directory, 'checkpoints'),
      database: { sqlitePath: path.join(directory, 'core.sqlite') },
      auth: {
        mode: 'account',
        issuer,
        ownerSubjectEnv: ownerEnv,
        levelCeilings: { 5: ['chat:read'] },
      },
      attachments: { localDirectory: path.join(directory, 'attachments') },
    }));
    const owner = await server.app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'Bearer owner' } });
    assert.equal(owner.statusCode, 200, owner.body);
    assert.equal(owner.json().data.level, 1);

    const guestSubject = sessions.guest!.subject;
    assert.equal((await putAccess(server, 'owner', principalId(guestSubject), {
      scopes: ['chat:read', 'chat:write'], enabled: true,
    })).statusCode, 200);
    const guest = await server.app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'Bearer guest' } });
    assert.equal(guest.statusCode, 200, guest.body);
    assert.equal(guest.json().data.level, 5);
    assert.deepEqual(guest.json().data.scopes, ['chat:read']);
  } finally {
    await server?.close();
    if (previousOwner === undefined) delete process.env[ownerEnv];
    else process.env[ownerEnv] = previousOwner;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Account principal ids use the canonical issuer origin and isolate grants between issuers', async () => {
  const issuerA = 'https://identity-a.example.test/tenant/path?region=one';
  const issuerB = 'https://identity-b.example.test/another/path?region=two';
  const originA = 'https://identity-a.example.test';
  const originB = 'https://identity-b.example.test';
  const authenticate = async (
    rawIssuer: string,
    subject: string,
    level: Principal['level'],
  ): Promise<Principal> => accountAuth(rawIssuer, (async () => Response.json({
    success: true,
    data: { session: {
      subject,
      level,
      scopes: ['*'],
      expiresAt: Math.floor(Date.now() / 1_000) + 600,
      applicationId: 'kiancode',
      audience: 'kiancode',
      credentialVersion: 1,
      consentVersion: 1,
    } },
  })) as typeof fetch, 'kiancode')('Bearer credential');

  const ownerA = await authenticate(issuerA, ownerSubject, 5);
  const memberA = await authenticate(issuerA, memberSubject, 2);
  const memberB = await authenticate(issuerB, memberSubject, 2);
  assert.equal(ownerA.issuer, originA);
  assert.equal(memberA.issuer, originA);
  assert.equal(memberB.issuer, originB);
  assert.equal(memberA.id, createHash('sha256').update(`${originA}\0${memberSubject}`).digest('hex'));
  assert.equal(memberB.id, createHash('sha256').update(`${originB}\0${memberSubject}`).digest('hex'));
  assert.notEqual(memberA.id, memberB.id);

  const store = new SqliteStore();
  try {
    const access = accountAccess(store);
    const owner = await access.authorize(ownerA);
    await access.grant(owner, memberA.id, { scopes: ['chat:read'], enabled: true });
    assert.deepEqual((await access.authorize(memberA)).scopes, ['chat:read']);
    await assert.rejects(access.authorize(memberB), hasCode('access_required', 403));
  } finally {
    await store.close();
  }
});
