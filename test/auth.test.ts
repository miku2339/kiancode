import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AccessService } from '../src/access.js';
import { accountAuth, oidcAuth } from '../src/auth.js';
import { SqliteStore } from '../src/storage/sqlite.js';

test('account authentication rejects expired/revoked credentials and never merges by email', async () => {
  let status = 200; let subject = `acct_${'a'.repeat(32)}`;
  const auth = accountAuth('https://identity.example', (async () => new Response(JSON.stringify({ success: true, data: { session: { subject, level: 1, scopes: ['chat:read'], email: 'same@example.com', expiresAt: new Date(Date.now() + 60000).toISOString() } } }), { status })) as typeof fetch);
  const first = await auth('Bearer credential'); subject = `acct_${'b'.repeat(32)}`;
  const second = await auth('Bearer credential'); assert.notEqual(first.id, second.id);
  status = 401; await assert.rejects(auth('Bearer credential'), /revoked/);
  const expired = accountAuth('https://identity.example', (async () => new Response(JSON.stringify({ success: true, data: { session: { subject, level: 1, scopes: ['*'], expiresAt: '2020-01-01T00:00:00Z' } } }))) as typeof fetch);
  await assert.rejects(expired('Bearer credential'), /invalid session/);
});

test('account authentication accepts Account Unix seconds and ISO expiry while rejecting invalid or expired boundaries', async () => {
  const subject = `acct_${'d'.repeat(32)}`;
  const authenticate = async (expiresAt: unknown) => accountAuth(
    'https://identity.example.test',
    (async () => new Response(JSON.stringify({
      success: true,
      data: { session: {
        subject,
        level: 1,
        scopes: ['account:profile', 'account:binding'],
        applicationId: 'kiancode-plus',
        audience: 'kiancode',
        credentialVersion: 1,
        expiresAt,
      } },
    }))) as typeof fetch,
    'kiancode',
    'https://identity-preview.example.test',
  )('Bearer account-token');

  const unixSeconds = Math.floor(Date.now() / 1_000) + 60;
  const fromSeconds = await authenticate(unixSeconds);
  assert.equal(fromSeconds.expiresAt, new Date(unixSeconds * 1_000).toISOString());

  const iso = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await authenticate(iso)).expiresAt, iso);
  const plusEightLocal = new Date(Date.parse(iso) + 8 * 60 * 60 * 1_000).toISOString().replace('Z', '+08:00');
  assert.equal((await authenticate(plusEightLocal)).expiresAt, iso);

  for (const expiresAt of [
    Math.floor(Date.now() / 1_000),
    -1,
    unixSeconds + 0.5,
    Date.now() + 60_000,
    new Date(0).toISOString(),
    'not-a-date',
    '2026-02-31T00:00:00Z',
    '2026-09-27T00:00:00+14:01',
    null,
  ]) {
    await assert.rejects(authenticate(expiresAt), /invalid session/);
  }
});

test('account API endpoint is separate from the canonical identity issuer', async () => {
  const subject = `acct_${'c'.repeat(32)}`;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/api/mobile-auth/session/')) {
      return new Response(JSON.stringify({
        success: true,
        data: { session: {
          subject,
          level: 1,
          scopes: ['chat:read'],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          applicationId: 'kiancode',
          audience: 'kiancode',
          credentialVersion: 4,
        } },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      success: true,
      data: { active: true, credentialVersion: 4 },
    }), { status: 200 });
  }) as typeof fetch;
  const issuer = 'https://identity.example';
  const localApi = 'http://127.0.0.1:8787';
  const localAuth = accountAuth(issuer, fetcher, 'kiancode', localApi);
  const remoteAuth = accountAuth(issuer, fetcher, 'kiancode', 'https://account-api.example');
  const localPrincipal = await localAuth('Bearer local-credential');
  const remotePrincipal = await remoteAuth('Bearer remote-credential');

  assert.equal(localPrincipal.id, remotePrincipal.id);
  assert.equal(localPrincipal.issuer, issuer);
  const store = new SqliteStore();
  try {
    const access = new AccessService(store, subject, 'service-token', 'account', localApi, fetcher);
    assert.equal(await access.validateDelegation(await access.authorize(localPrincipal)), true);
  } finally {
    await store.close();
  }

  assert.deepEqual(requests.map((request) => request.url), [
    `${localApi}/api/mobile-auth/session/`,
    'https://account-api.example/api/mobile-auth/session/',
    `${localApi}/api/internal/authorization/check/`,
  ]);
  assert.ok(requests.every((request) => request.init?.redirect === 'error'));
  assert.throws(
    () => accountAuth(issuer, fetcher, 'kiancode', 'https://user:secret@account-api.example'),
    /must not include user information/,
  );
});

test('OIDC authentication verifies issuer, audience, JWKS signature, expiry, and optional introspection', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let active = true;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === 'https://idp.example/keys') {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return new Response(JSON.stringify({ active, sub: 'opaque-user-42', exp: Math.floor(Date.now() / 1_000) + 60 }), { status: 200 });
  }) as typeof fetch;
  const authenticate = oidcAuth({
    issuer: 'https://idp.example/tenant',
    audience: 'kiancode',
    jwksUri: 'https://idp.example/keys',
    fetch: fetcher,
    introspection: { url: 'https://idp.example/introspect', clientId: 'core', clientSecret: 'secret' },
  });
  const token = await new SignJWT({ scope: 'chat:read task:read' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://idp.example/tenant')
    .setAudience('kiancode')
    .setSubject('opaque-user-42')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(privateKey);
  const principal = await authenticate(`Bearer ${token}`);
  assert.equal(principal.subject, 'opaque-user-42');
  assert.equal(principal.level, 5);
  assert.deepEqual(principal.scopes, ['chat:read', 'task:read']);
  assert.match(principal.expiresAt ?? '', /^\d{4}-/);
  const introspection = requests.find((request) => request.url.endsWith('/introspect'));
  assert.match(String((introspection?.init?.headers as Record<string, string>).authorization), /^Basic /);
  assert.equal(introspection?.init?.redirect, 'error');

  assert.equal((await authenticate.reauthorize!(principal)).id, principal.id);

  active = false;
  await assert.rejects(authenticate.reauthorize!(principal), /inactive/);
  await assert.rejects(authenticate(`Bearer ${token}`), /inactive/);
  const wrongAudience = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://idp.example/tenant')
    .setAudience('other')
    .setSubject('opaque-user-42')
    .setExpirationTime('1m')
    .sign(privateKey);
  await assert.rejects(authenticate(`Bearer ${wrongAudience}`), /invalid|expired/i);
});
