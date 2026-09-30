import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { DomainError, type Principal } from './contracts.js';

export interface Authenticator {
  (authorization: string | undefined): Promise<Principal>;
  reauthorize?(principal: Principal): Promise<Principal>;
}

export function bearer(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 16384) throw new DomainError('unauthorized', 'Sign in to continue', 401);
  const token = authorization.slice(7);
  if (!token || /\s/.test(token)) throw new DomainError('unauthorized', 'Invalid bearer token', 401);
  return token;
}

export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export function developmentAuth(token: string): Authenticator {
  if (token.length < 32) throw new Error('Development token must contain at least 32 characters');
  const expected = createHash('sha256').update(token).digest();
  return async (authorization) => {
    const received = createHash('sha256').update(bearer(authorization)).digest();
    if (!timingSafeEqual(received, expected)) throw new DomainError('unauthorized', 'Invalid bearer token', 401);
    return { id: 'local-owner', level: 1, scopes: ['*'] };
  };
}

export function accountAuth(
  issuer: string,
  fetcher: typeof fetch = fetch,
  expectedAudience?: string,
  accountApiUrl?: string,
): Authenticator {
  const url = secureUrl(issuer, 'Account issuer');
  const canonicalIssuer = url.origin;
  const accountApiOrigin = accountApiUrl ? secureAccountApiOrigin(accountApiUrl) : canonicalIssuer;
  return async (authorization) => {
    const token = bearer(authorization);
    let response: Response;
    try {
      response = await fetcher(new URL('/api/mobile-auth/session/', accountApiOrigin), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    } catch { throw new DomainError('identity_unavailable', 'Account service is unavailable', 503); }
    if (!response.ok) throw new DomainError(response.status === 401 ? 'unauthorized' : 'identity_unavailable', response.status === 401 ? 'Session expired or revoked' : 'Account service is unavailable', response.status === 401 ? 401 : 503);
    const envelope = await response.json() as { success?: boolean; data?: { session?: { subject?: string; level?: number; scopes?: unknown; expiresAt?: string | number; applicationId?: string; audience?: string; credentialVersion?: number } } };
    const session = envelope.data?.session;
    const expiresAt = accountSessionExpiry(session?.expiresAt);
    if (!envelope.success || !session?.subject?.match(/^acct_[0-9a-f]{32}$/) || ![1, 2, 3, 4, 5].includes(session.level ?? 0)
      || !Array.isArray(session.scopes) || session.scopes.some((scope) => typeof scope !== 'string') || !expiresAt) {
      throw new DomainError('invalid_identity', 'Account returned an invalid session', 401);
    }
    if (expectedAudience && (session.audience !== expectedAudience || !session.applicationId || !Number.isInteger(session.credentialVersion))) throw new DomainError('invalid_audience', 'This session is not authorized for Kian', 403);
    return { id: createHash('sha256').update(`${canonicalIssuer}\0${session.subject}`).digest('hex'), issuer: canonicalIssuer, subject: session.subject, level: session.level as Principal['level'], scopes: session.scopes as string[], applicationId: session.applicationId, audience: session.audience, credentialVersion: session.credentialVersion, expiresAt };
  };
}

function accountSessionExpiry(value: unknown): string | undefined {
  let milliseconds: number;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 253_402_300_799) return undefined;
    milliseconds = value * 1_000;
  } else if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return undefined;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const fraction = Number((match[7] ?? '').padEnd(3, '0'));
    if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
    const local = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
    const localDate = new Date(local);
    if (localDate.getUTCFullYear() !== year || localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day) return undefined;
    const zone = match[8]!;
    const offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
    const offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return undefined;
    const offset = zone === 'Z' ? 0 : (zone.startsWith('+') ? 1 : -1) * (offsetHours * 60 + offsetMinutes) * 60_000;
    milliseconds = local - offset;
    if (milliseconds !== Date.parse(value)) return undefined;
  } else {
    return undefined;
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= Date.now()) return undefined;
  return new Date(milliseconds).toISOString();
}

export function secureAccountApiOrigin(raw: string): string {
  const url = secureUrl(raw, 'Account API URL');
  if (url.username || url.password) throw new Error('Account API URL must not include user information');
  return url.origin;
}

export interface OidcAuthOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  fetch?: typeof fetch;
  introspection?: { url: string; clientId: string; clientSecret: string };
}

export function oidcAuth(options: OidcAuthOptions): Authenticator {
  const issuer = secureUrl(options.issuer, 'OIDC issuer').href.replace(/\/$/, '');
  const jwksUri = secureUrl(options.jwksUri, 'OIDC JWKS URI');
  const fetcher = options.fetch ?? fetch;
  const jwks = createRemoteJWKSet(jwksUri, {
    timeoutDuration: 5_000,
    [customFetch]: (url, init) => fetcher(url, { ...init, redirect: 'error' }),
  });
  const introspection = options.introspection ? {
    ...options.introspection,
    url: secureUrl(options.introspection.url, 'OIDC introspection URL'),
  } : undefined;
  const sessions = new Map<string, { token: string; expiresAt: number }>();
  const authenticate: Authenticator = async (authorization) => {
    const token = bearer(authorization);
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: options.audience,
        clockTolerance: 5,
      }));
    } catch {
      throw new DomainError('unauthorized', 'Invalid or expired OIDC token', 401);
    }
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255
      || typeof payload.exp !== 'number' || payload.exp * 1_000 <= Date.now()) {
      throw new DomainError('invalid_identity', 'OIDC returned an invalid subject or expiry', 401);
    }
    if (introspection) await requireActiveToken(fetcher, introspection, token, payload.sub);
    const scopes = typeof payload.scope === 'string'
      ? payload.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(payload.scp) && payload.scp.every((scope: unknown) => typeof scope === 'string')
        ? payload.scp as string[]
        : [];
    const principal: Principal = {
      id: createHash('sha256').update(`${issuer}\0${payload.sub}`).digest('hex'),
      issuer,
      subject: payload.sub,
      level: 5,
      scopes,
      applicationId: options.audience,
      audience: options.audience,
      expiresAt: new Date(payload.exp * 1_000).toISOString(),
    };
    rememberOidcSession(sessions, principal.id, token, payload.exp * 1_000);
    return principal;
  };
  authenticate.reauthorize = async (principal) => {
    const session = sessions.get(principal.id);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(principal.id);
      throw new DomainError('unauthorized', 'OIDC session must be authenticated again', 401);
    }
    const refreshed = await authenticate(`Bearer ${session.token}`);
    if (refreshed.id !== principal.id || refreshed.subject !== principal.subject) {
      throw new DomainError('unauthorized', 'OIDC identity changed', 401);
    }
    return refreshed;
  };
  return authenticate;
}

function rememberOidcSession(
  sessions: Map<string, { token: string; expiresAt: number }>,
  principalId: string,
  token: string,
  expiresAt: number,
): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  if (!sessions.has(principalId) && sessions.size >= 10_000) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest) sessions.delete(oldest);
  }
  sessions.delete(principalId);
  sessions.set(principalId, { token, expiresAt });
}

function secureUrl(raw: string, label: string): URL {
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS`);
  }
  return url;
}

async function requireActiveToken(
  fetcher: typeof fetch,
  introspection: { url: URL; clientId: string; clientSecret: string },
  token: string,
  subject: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(introspection.url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${introspection.clientId}:${introspection.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token }),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new DomainError('identity_unavailable', 'OIDC introspection is unavailable', 503);
  }
  if (!response.ok) throw new DomainError('identity_unavailable', 'OIDC introspection is unavailable', 503);
  const result = await response.json() as { active?: boolean; sub?: string; exp?: number };
  if (result.active !== true || result.sub !== subject
    || (result.exp !== undefined && (!Number.isFinite(result.exp) || result.exp * 1_000 <= Date.now()))) {
    throw new DomainError('unauthorized', 'OIDC token is inactive', 401);
  }
}

export function requireScope(principal: Principal, scope: string): void {
  if (principal.scopes.some((grant) => grant === '*' || grant === 'kiancode:*' || grant === scope || grant === `kiancode:${scope}` || grant === `${scope.split(':')[0]}:*`)) return;
  throw new DomainError('forbidden', `Missing capability: ${scope}`, 403);
}

export function requireOwner(principal: Principal): void {
  if (principal.level !== 1) throw new DomainError('owner_required', 'This action requires the account owner', 403);
}
