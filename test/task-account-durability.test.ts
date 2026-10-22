import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AccessService, type AccessGrant } from '../src/access.js';
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import { DomainError, type Principal, type Workspace } from '../src/contracts.js';
import type { Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService } from '../src/tasks.js';

const issuer = 'https://account.example.test';
const ownerSubject = `acct_${'a'.repeat(32)}`;
const memberSubject = `acct_${'b'.repeat(32)}`;
const token = 'controlled-account-session-fixture';
const headers = { authorization: `Bearer ${token}` };
const issuedGrantVersion = 9;
const issuedAuthenticatedAt = 1_700_000_000;
const issuedAuthorizationId = 'authorization_web_1234567890';

function principalId(subject: string): string {
  return createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
}

function ownerIdentity(expiresAt: string): Principal {
  return {
    id: principalId(ownerSubject),
    issuer,
    subject: ownerSubject,
    level: 1,
    scopes: ['*'],
    applicationId: 'kiancode',
    audience: 'kiancode',
    authorizationId: issuedAuthorizationId,
    credentialVersion: 7,
    consentVersion: 3,
    grantVersion: issuedGrantVersion,
    authenticatedAt: issuedAuthenticatedAt,
    expiresAt,
  };
}

function reauthorizeWith(access: AccessService): (principal: Principal) => Promise<Principal> {
  return async (principal) => {
    if (!await access.validateDelegation(principal)) {
      throw new DomainError('grant_revoked', 'Task authorization has expired or been revoked', 403);
    }
    return access.authorize(principal);
  };
}

test('controlled Account fixture resumes an admitted act workspace task after session expiry and a long Mac disconnect', async () => {
  const store = new SqliteStore();
  const admittedAt = Date.now();
  const identity = ownerIdentity(new Date(admittedAt + 900_000).toISOString());
  let authenticatedIdentity = identity;
  const audit: string[] = [];
  let authorizationChecks = 0;
  let executions = 0;
  const accountAuthorization = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorizationChecks += 1;
    audit.push('account-authorization-check');
    const body = JSON.parse(String(init?.body)) as {
      subject: string;
      applicationId: string;
      authorizationId: string;
      credentialVersion: number;
      consentVersion: number;
      grantVersion: number;
      authenticatedAt: number;
    };
    assert.deepEqual(body, {
      subject: ownerSubject,
      applicationId: 'kiancode',
      authorizationId: issuedAuthorizationId,
      credentialVersion: 7,
      consentVersion: 3,
      grantVersion: issuedGrantVersion,
      authenticatedAt: issuedAuthenticatedAt,
    });
    return Response.json({ success: true, data: { active: true, credentialVersion: 7, consentVersion: 3, grantVersion: issuedGrantVersion } });
  }) as typeof fetch;
  const access = new AccessService(
    store,
    ownerSubject,
    'controlled-service-token',
    'account',
    issuer,
    accountAuthorization,
    {},
    { expectedIssuer: issuer, expectedAudience: 'kiancode' },
  );
  const runner = async () => {
    executions += 1;
    audit.push('runner-dispatch');
    if (executions === 1) {
      throw new DomainError('waiting_for_device', 'The controlled Mac fixture is offline', 503);
    }
    return { text: 'continued after reconnect' };
  };
  const server = await createServer({
    store,
    access,
    authenticate: async (authorization) => {
      assert.equal(authorization, `Bearer ${token}`);
      return access.authorize(authenticatedIdentity);
    },
    runner,
  });
  let resumed: TaskService | undefined;
  try {
    const workspace = await store.create<Workspace>('workspace', identity.id, {
      id: 'controlled-mac-workspace',
      ownerId: identity.id,
      name: 'Controlled Mac fixture',
      root: '/controlled-fixture',
      deviceId: 'controlled-mac',
      capabilities: [],
      allowCloud: false,
    }, 'controlled-mac-workspace');
    const conversation = await server.app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers,
      payload: { title: 'Durable owner task', mode: 'act', workspaceId: workspace.id },
    });
    assert.equal(conversation.statusCode, 201, conversation.body);
    const fakeGrant = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json().data.id}/messages`,
      headers,
      payload: {
        content: 'Inject a durable grant',
        accountTaskGrant: {
          issuer,
          subject: ownerSubject,
          applicationId: 'kiancode',
          audience: 'kiancode',
          credentialVersion: 7,
          consentVersion: 3,
          scopes: ['*'],
          rootTaskId: 'fake',
        },
      },
    });
    assert.equal(fakeGrant.statusCode, 400, fakeGrant.body);
    const sent = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json().data.id}/messages`,
      headers,
      payload: { content: 'Continue when my Mac reconnects', requestId: 'account-durable-task' },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    const taskId = sent.json().data.id as string;

    await server.tasks.drain();
    const waiting = await store.get<Task>('task', taskId, identity.id);
    assert.equal(waiting?.data.state, 'waiting_for_device', waiting?.data.error);
    assert.equal(waiting?.data.principal.consentVersion, 3);
    assert.equal(waiting?.data.accountTaskGrant?.consentVersion, 3);
    assert.equal(waiting?.data.principal.authorizationId, issuedAuthorizationId);
    assert.equal(waiting?.data.accountTaskGrant?.authorizationId, issuedAuthorizationId);
    assert.equal(waiting?.data.principal.grantVersion, issuedGrantVersion);
    assert.equal(waiting?.data.principal.authenticatedAt, issuedAuthenticatedAt);
    assert.equal(waiting?.data.accountTaskGrant?.grantVersion, issuedGrantVersion);
    assert.equal(waiting?.data.accountTaskGrant?.authenticatedAt, issuedAuthenticatedAt);
    await server.tasks.close();

    audit.length = 0;
    authorizationChecks = 0;
    const resumedAt = Date.parse(identity.expiresAt!) + 3_600_001;
    resumed = new TaskService(store, runner, {
      now: () => resumedAt,
      durableGrants: access.unattendedAuthorization() === 'durable',
      reauthorize: reauthorizeWith(access),
    });
    await resumed.drain();

    const completed = await store.get<Task>('task', taskId, identity.id);
    assert.equal(completed?.data.state, 'completed', completed?.data.error);
    assert.equal(completed?.data.result, 'continued after reconnect');
    assert.equal(completed?.data.principal.authorizationId, issuedAuthorizationId);
    assert.equal(completed?.data.accountTaskGrant?.authorizationId, issuedAuthorizationId);
    assert.equal(executions, 2);
    assert.equal(authorizationChecks, 1);
    assert.deepEqual(audit, ['account-authorization-check', 'runner-dispatch']);
    assert.ok(Date.parse(completed!.data.grantExpiresAt) > resumedAt);
    assert.ok(Date.parse(completed!.data.grantExpiresAt) <= resumedAt + 3_600_000);

    const legacy = await resumed.enqueue(
      await access.authorize(identity),
      conversation.json().data.id,
      'Keep the old session policy',
      'legacy-account-task',
    );
    const legacyRetry = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json().data.id}/messages`,
      headers,
      payload: { content: 'Keep the old session policy', requestId: 'legacy-account-task' },
    });
    assert.equal(legacyRetry.statusCode, 202, legacyRetry.body);
    assert.equal(legacyRetry.json().data.id, legacy.id);
    assert.equal(legacyRetry.json().data.data.accountTaskGrant, undefined);
    assert.equal(legacyRetry.json().data.data.principal.expiresAt, identity.expiresAt);

    authenticatedIdentity = ownerIdentity(new Date(resumedAt + 900_000).toISOString());
    const rollbackTask = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json().data.id}/messages`,
      headers,
      payload: { content: 'Repair rollback state', requestId: 'rollback-account-task' },
    });
    assert.equal(rollbackTask.statusCode, 202, rollbackTask.body);
    const rollbackId = rollbackTask.json().data.id as string;
    const rollbackStored = (await store.get<Task>('task', rollbackId, identity.id))!;
    await store.put<Task>('task', rollbackId, identity.id, {
      ...rollbackStored.data,
      principal: { ...rollbackStored.data.principal, expiresAt: authenticatedIdentity.expiresAt },
      state: 'paused',
    }, rollbackStored.revision);
    await assert.rejects(
      resumed.control(identity.id, rollbackId, 'resume', [], {
        ...authenticatedIdentity,
        grantVersion: issuedGrantVersion + 1,
        authenticatedAt: issuedAuthenticatedAt + 60,
      }),
      (error: unknown) => error instanceof DomainError && error.code === 'grant_revoked',
    );
    await assert.rejects(
      resumed.control(identity.id, rollbackId, 'resume', [], {
        ...authenticatedIdentity,
        authorizationId: 'authorization_other_1234567890',
      }),
      (error: unknown) => error instanceof DomainError && error.code === 'grant_revoked',
    );
    const repaired = await resumed.control(identity.id, rollbackId, 'resume', [], authenticatedIdentity);
    assert.equal(repaired.data.state, 'queued');
    assert.equal(repaired.data.principal.expiresAt, undefined);
    assert.deepEqual(repaired.data.accountTaskGrant, rollbackStored.data.accountTaskGrant);

    const coordinator = new AgentCoordinator(store);
    const plan = await coordinator.prepare(identity.id, rollbackId, {
      key: 'issued-grant-child',
      strategy: 'single',
      children: [{ key: 'worker', prompt: 'Continue with the admitted snapshot' }],
      budget: { maxCalls: 2, maxTokens: 1_000 },
    });
    const [child] = await coordinator.runChildren(identity.id, plan.id);
    assert.equal(child?.data.principal.grantVersion, issuedGrantVersion);
    assert.equal(child?.data.principal.authenticatedAt, issuedAuthenticatedAt);
    assert.equal(child?.data.principal.authorizationId, issuedAuthorizationId);
    assert.equal(child?.data.accountTaskGrant?.grantVersion, issuedGrantVersion);
    assert.equal(child?.data.accountTaskGrant?.authenticatedAt, issuedAuthenticatedAt);
    assert.equal(child?.data.accountTaskGrant?.authorizationId, issuedAuthorizationId);
  } finally {
    await resumed?.close();
    await server.close();
  }
});

test('controlled Account task grant stops before dispatch on Account, Core scope, or descriptor changes', async () => {
  const store = new SqliteStore();
  const id = principalId(memberSubject);
  let accountActive = true;
  let accountApplicationActive = true;
  let accountCredentialVersion = 7;
  let accountConsentVersion = 3;
  let authorizationChecks = 0;
  let executions = 0;
  const accountAuthorization = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorizationChecks += 1;
    const body = JSON.parse(String(init?.body)) as {
      applicationId: string;
      credentialVersion: number;
      consentVersion: number;
      grantVersion?: number;
      authenticatedAt?: number;
    };
    assert.equal(body.grantVersion, undefined);
    assert.equal(body.authenticatedAt, undefined);
    return Response.json({
      success: true,
      data: {
        active: accountActive && accountApplicationActive && body.applicationId === 'kiancode',
        credentialVersion: accountCredentialVersion,
        consentVersion: accountConsentVersion,
        grantVersion: 0,
      },
    });
  }) as typeof fetch;
  const access = new AccessService(
    store,
    ownerSubject,
    'controlled-service-token',
    'account',
    issuer,
    accountAuthorization,
    {},
    { expectedIssuer: issuer, expectedAudience: 'kiancode' },
  );
  const reauthorize = reauthorizeWith(access);
  const runner = async () => {
    executions += 1;
    if (executions === 1) {
      throw new DomainError('waiting_for_device', 'The controlled Mac fixture is offline', 503);
    }
    return { text: 'must not dispatch' };
  };
  let initial: TaskService | undefined;
  try {
    let grant = await store.create<AccessGrant>('access', id, {
      scopes: ['chat:write', 'workspace:read'],
      enabled: true,
    }, id);
    const admitted = await access.authorize({
      id,
      issuer,
      subject: memberSubject,
      level: 2,
      scopes: [],
      applicationId: 'kiancode',
      audience: 'kiancode',
      credentialVersion: 7,
      consentVersion: 3,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    const conversation = await store.create('conversation', id, {
      title: 'Fail closed',
      scope: 'private',
      modelPolicy: 'cloud',
      strategy: 'single',
      mode: 'act',
      archived: false,
    });
    const admittedAt = Date.now();
    initial = new TaskService(store, runner, {
      now: () => admittedAt,
      durableGrants: true,
      reauthorize,
    });
    const queued = await initial.enqueue(
      admitted,
      conversation.id,
      'Wait for the controlled Mac',
      'fail-closed-account-task',
      [],
      [],
      undefined,
      undefined,
      { accountTaskGrant: access.accountTaskGrant(admitted)! },
    );
    await initial.drain();
    const waiting = await store.get<Task>('task', queued.id, id);
    assert.equal(waiting?.data.state, 'waiting_for_device', waiting?.data.error);
    assert.equal(waiting?.data.accountTaskGrant?.grantVersion, undefined);
    assert.equal(waiting?.data.accountTaskGrant?.authenticatedAt, undefined);
    await initial.close();
    initial = undefined;
    const resumedAt = Date.parse(admitted.expiresAt!) + 3_600_001;

    const restoreWaiting = async (change?: (task: Task) => Task) => {
      const current = (await store.get<Task>('task', queued.id, id))!;
      await store.put<Task>('task', queued.id, id, change?.(waiting!.data) ?? waiting!.data, current.revision);
    };
    const runExpired = async () => {
      const service = new TaskService(store, runner, {
        now: () => resumedAt,
        durableGrants: true,
        reauthorize,
      });
      try {
        await service.drain();
        return (await store.get<Task>('task', queued.id, id))!;
      } finally {
        await service.close();
      }
    };

    authorizationChecks = 0;
    accountActive = false;
    accountCredentialVersion = 0;
    accountConsentVersion = 0;
    const unknownOrDeleted = await runExpired();
    const unknownOrDeletedAgain = await runExpired();
    const unknownOrDeletedChecks = authorizationChecks;
    await restoreWaiting();
    accountActive = true;
    accountCredentialVersion = 7;
    accountConsentVersion = 3;
    authorizationChecks = 0;
    accountCredentialVersion = 8;
    const credentialRotated = await runExpired();
    const credentialRotatedChecks = authorizationChecks;
    await restoreWaiting();
    accountCredentialVersion = 7;
    accountConsentVersion = 4;
    authorizationChecks = 0;
    const consentRegranted = await runExpired();
    const consentRegrantedChecks = authorizationChecks;
    const regrantControl = new TaskService(store, runner, {
      now: () => resumedAt,
      durableGrants: true,
      reauthorize,
    });
    try {
      await assert.rejects(
        regrantControl.control(id, queued.id, 'resume', [], {
          ...admitted,
          consentVersion: 4,
          expiresAt: new Date(resumedAt + 900_000).toISOString(),
        }),
        (error: unknown) => error instanceof DomainError && error.code === 'grant_revoked',
      );
    } finally {
      await regrantControl.close();
    }
    await restoreWaiting();
    accountConsentVersion = 3;
    authorizationChecks = 0;
    accountApplicationActive = false;
    const applicationRevoked = await runExpired();
    const applicationRevokedChecks = authorizationChecks;
    await restoreWaiting();
    accountApplicationActive = true;
    grant = (await store.get<AccessGrant>('access', id, id))!;
    await store.put<AccessGrant>('access', id, id, {
      scopes: ['chat:write'],
      enabled: true,
    }, grant.revision);
    authorizationChecks = 0;
    const scopeReduced = await runExpired();
    const scopeReducedChecks = authorizationChecks;
    await restoreWaiting((task) => ({
      ...task,
      accountTaskGrant: { ...task.accountTaskGrant!, subject: ownerSubject },
    }));
    authorizationChecks = 0;
    const descriptorTampered = await runExpired();
    const descriptorTamperedChecks = authorizationChecks;
    await restoreWaiting((task) => ({
      ...task,
      principal: { ...task.principal, grantVersion: 9 },
      accountTaskGrant: { ...task.accountTaskGrant!, grantVersion: 9 },
    }));
    authorizationChecks = 0;
    const incompleteGrantSnapshot = await runExpired();
    const incompleteGrantSnapshotChecks = authorizationChecks;
    await restoreWaiting((task) => {
      const { consentVersion: _principalConsentVersion, ...principal } = task.principal;
      const { consentVersion: _grantConsentVersion, ...accountTaskGrant } = task.accountTaskGrant!;
      return { ...task, principal, accountTaskGrant } as Task;
    });
    authorizationChecks = 0;
    const legacyWithoutConsent = await runExpired();
    const legacyWithoutConsentChecks = authorizationChecks;

    assert.deepEqual({
      unknownOrDeleted: unknownOrDeleted.data.state,
      unknownOrDeletedAgain: unknownOrDeletedAgain.data.state,
      credentialRotated: credentialRotated.data.state,
      consentRegranted: consentRegranted.data.state,
      applicationRevoked: applicationRevoked.data.state,
      scopeReduced: scopeReduced.data.state,
      descriptorTampered: descriptorTampered.data.state,
      incompleteGrantSnapshot: incompleteGrantSnapshot.data.state,
      legacyWithoutConsent: legacyWithoutConsent.data.state,
      unknownOrDeletedChecks,
      credentialRotatedChecks,
      consentRegrantedChecks,
      applicationRevokedChecks,
      scopeReducedChecks,
      descriptorTamperedChecks,
      incompleteGrantSnapshotChecks,
      legacyWithoutConsentChecks,
      executions,
    }, {
      unknownOrDeleted: 'paused',
      unknownOrDeletedAgain: 'paused',
      credentialRotated: 'paused',
      consentRegranted: 'paused',
      applicationRevoked: 'paused',
      scopeReduced: 'paused',
      descriptorTampered: 'paused',
      incompleteGrantSnapshot: 'paused',
      legacyWithoutConsent: 'paused',
      unknownOrDeletedChecks: 1,
      credentialRotatedChecks: 1,
      consentRegrantedChecks: 1,
      applicationRevokedChecks: 1,
      scopeReducedChecks: 0,
      descriptorTamperedChecks: 0,
      incompleteGrantSnapshotChecks: 0,
      legacyWithoutConsentChecks: 0,
      executions: 1,
    });

    await restoreWaiting();
    grant = (await store.get<AccessGrant>('access', id, id))!;
    await store.put<AccessGrant>('access', id, id, {
      scopes: ['chat:write', 'workspace:read'],
      enabled: true,
    }, grant.revision);
    const coordinator = new AgentCoordinator(store);
    const childExpiry = new Date(admittedAt + 1_000).toISOString();
    const childRequest = {
      key: 'account-grant-child',
      strategy: 'single' as const,
      children: [{
        key: 'worker',
        prompt: 'Read the workspace',
        scopes: ['workspace:read'],
        grantExpiresAt: childExpiry,
      }],
      budget: { maxCalls: 2, maxTokens: 1_000 },
    };
    const plan = await coordinator.prepare(id, queued.id, childRequest);
    const [child] = await coordinator.runChildren(id, plan.id);
    assert.equal(child?.data.accountTaskGrant?.rootTaskId, queued.id);
    assert.equal(child?.data.accountTaskGrant?.consentVersion, 3);
    assert.equal(child?.data.accountTaskGrant?.grantVersion, undefined);
    assert.equal(child?.data.accountTaskGrant?.authenticatedAt, undefined);
    assert.deepEqual(child?.data.accountTaskGrant?.scopes, ['workspace:read']);
    assert.equal(child?.data.accountTaskGrant?.delegationExpiresAt, childExpiry);
    assert.deepEqual(child?.data.principal.scopes, ['workspace:read']);
    assert.equal(child?.data.principal.consentVersion, 3);
    assert.equal(child?.data.principal.expiresAt, undefined);

    let cappedNow = Date.parse(childExpiry) - 1;
    let cappedRuns = 0;
    const cappedService = new TaskService(store, async ({ onEvent }) => {
      cappedRuns += 1;
      cappedNow = Date.parse(childExpiry) + 1;
      await onEvent({ type: 'model_call' });
      return { text: 'must stop at the delegation ceiling' };
    }, {
      now: () => cappedNow,
      durableGrants: true,
      reauthorize,
    });
    try {
      await cappedService.drain();
      const capped = (await store.get<Task>('task', child!.id, id))!;
      assert.equal(capped.data.state, 'paused', capped.data.error);
      assert.equal(cappedRuns, 1);
      await assert.rejects(
        cappedService.control(id, child!.id, 'resume', [], admitted),
        (error: unknown) => error instanceof DomainError && error.code === 'grant_expired',
      );
    } finally {
      await cappedService.close();
    }

    const nestedPlan = await coordinator.prepare(id, child!.id, {
      key: 'nested-account-grant-child',
      strategy: 'single',
      children: [{ key: 'nested-worker', prompt: 'Keep the inherited ceiling' }],
    });
    const [nestedChild] = await coordinator.runChildren(id, nestedPlan.id);
    assert.equal(nestedChild?.data.accountTaskGrant?.rootTaskId, queued.id);
    assert.equal(nestedChild?.data.accountTaskGrant?.consentVersion, 3);
    assert.equal(nestedChild?.data.accountTaskGrant?.delegationExpiresAt, childExpiry);
    const expiredNestedService = new TaskService(store, async () => {
      cappedRuns += 1;
      return { text: 'must not run' };
    }, {
      now: () => cappedNow,
      durableGrants: true,
      reauthorize,
    });
    try {
      await expiredNestedService.drain();
      assert.equal((await store.get<Task>('task', nestedChild!.id, id))?.data.state, 'paused');
      assert.equal(cappedRuns, 1);
    } finally {
      await expiredNestedService.close();
    }

    const childCurrent = (await store.get<Task>('task', child!.id, id))!;
    const { accountTaskGrant: _accountTaskGrant, ...childWithoutGrant } = childCurrent.data;
    await store.put<Task>('task', childCurrent.id, id, childWithoutGrant, childCurrent.revision);
    const planCurrent = (await store.get<OrchestrationPlan>('agent_plan', plan.id, id))!;
    await store.put<OrchestrationPlan>('agent_plan', plan.id, id, {
      ...planCurrent.data,
      state: 'preparing',
    }, planCurrent.revision);
    await assert.rejects(
      coordinator.prepare(id, queued.id, childRequest),
      (error: unknown) => error instanceof DomainError && error.code === 'idempotency_conflict',
    );
  } finally {
    await initial?.close();
    await store.close();
  }
});

test('an expired bare Account principal remains invalid without a server-issued task grant', async () => {
  const store = new SqliteStore();
  let authorizationChecks = 0;
  const access = new AccessService(
    store,
    ownerSubject,
    'controlled-service-token',
    'account',
    issuer,
    (async () => {
      authorizationChecks += 1;
      return Response.json({ success: true, data: { active: true, credentialVersion: 7, consentVersion: 3, grantVersion: 0 } });
    }) as typeof fetch,
    {},
    { expectedIssuer: issuer, expectedAudience: 'kiancode' },
  );
  try {
    const expired = ownerIdentity(new Date(Date.now() - 1).toISOString());
    assert.equal(await access.validateDelegation(expired), false);
    assert.equal(authorizationChecks, 0);
  } finally {
    await store.close();
  }
});
