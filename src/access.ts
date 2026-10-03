import { requireOwner, requireScope, scopeAllows, secureAccountApiOrigin } from './auth.js';
import { DomainError, type Principal } from './contracts.js';
import type { Store } from './storage/store.js';

export interface AccessGrant { scopes: string[]; enabled: boolean }

export type LevelCeilings = Partial<Record<2 | 3 | 4 | 5, readonly string[]>>;

const conversationalCeiling: readonly string[] = [
  'chat:read', 'chat:write', 'task:read', 'task:write', 'memory:read', 'memory:write',
  'agent:read', 'agent:write', 'artifact:read', 'artifact:write', 'notification:read', 'notification:write',
  'model:read', 'workspace:read', 'device:read', 'approval:write', 'schedule:read',
];
const builtInCeilings: Record<2 | 3 | 4 | 5, readonly string[]> = {
  2: conversationalCeiling,
  3: conversationalCeiling,
  4: conversationalCeiling,
  5: [],
};
const principalIdPattern = /^[0-9a-f]{64}$/;
const scopePattern = /^[\x21-\x7e]{1,100}$/;

function accessRequired(): DomainError {
  return new DomainError('access_required', 'Kian access has not been granted', 403);
}

function intersectScopes(record: readonly string[], ceiling: readonly string[]): string[] {
  return [...new Set([
    ...record.filter((scope) => scopeAllows(ceiling, scope)),
    ...ceiling.filter((scope) => scopeAllows(record, scope)),
  ])];
}

export class AccessService {
  private accountApiOrigin?: string;

  constructor(
    private store: Store,
    private ownerSubject?: string,
    private serviceToken?: string,
    private identityMode: 'account' | 'oidc' | 'development' = 'account',
    accountApiUrl?: string,
    private fetcher: typeof fetch = fetch,
    private levelCeilings: LevelCeilings = {},
  ) {
    if (ownerSubject && (ownerSubject.length > 255 || ownerSubject.includes('\0'))) throw new Error('The Kian owner subject is invalid');
    this.accountApiOrigin = accountApiUrl ? secureAccountApiOrigin(accountApiUrl) : undefined;
  }
  async authorize(identity: Principal): Promise<Principal> {
    if (this.identityMode === 'development') return identity;
    if (!identity.issuer || !identity.subject) throw accessRequired();
    if (identity.subject === this.ownerSubject) return { ...identity, level: 1, scopes: ['*'] };
    const grant = await this.store.get<AccessGrant>('access', identity.id, identity.id);
    if (grant && !grant.data.enabled) throw new DomainError('access_revoked', 'Kian access has been revoked', 403);
    if (!grant) throw accessRequired();
    const level = Math.max(identity.level, 2) as 2 | 3 | 4 | 5;
    const scopes = intersectScopes(grant.data.scopes, this.levelCeilings[level] ?? builtInCeilings[level]);
    if (scopes.length === 0) throw accessRequired();
    return { ...identity, level, scopes };
  }
  async grant(actor: Principal, principalId: string, grant: AccessGrant) {
    requireOwner(actor);
    requireScope(actor, 'admin:grant');
    if (principalId === actor.id) {
      throw new DomainError('invalid_principal', 'The owner does not need an access record', 400);
    }
    if (this.identityMode !== 'development' && !principalIdPattern.test(principalId)) {
      throw new DomainError('invalid_principal', 'Access records are addressed by a 64-character lowercase hex principal id', 400);
    }
    for (const scope of grant.scopes) {
      if (!scopePattern.test(scope)) {
        throw new DomainError('invalid_scope', 'Scopes must be 1 to 100 printable ASCII characters without spaces', 400);
      }
      if (scopeAllows([scope], 'admin:grant')) {
        throw new DomainError('invalid_scope', `Scope cannot be granted: ${scope}`, 400);
      }
    }
    const existing = await this.store.get<AccessGrant>('access', principalId, principalId);
    return existing ? this.store.put('access', principalId, principalId, grant, existing.revision) : this.store.create('access', principalId, grant, principalId);
  }
  async validateDelegation(principal: Principal): Promise<boolean> {
    const expiresAt = principal.expiresAt ? Date.parse(principal.expiresAt) : undefined;
    if ((this.identityMode === 'oidc' && expiresAt === undefined)
      || (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) return false;
    const fresh = await this.authorize(principal);
    if (!principal.scopes.every((scope) => scopeAllows(fresh.scopes, scope))) return false;
    if (!principal.issuer || this.identityMode === 'development') return true;
    if (this.identityMode === 'oidc') return true;
    if (!this.serviceToken || !principal.subject || !principal.applicationId || principal.credentialVersion === undefined) return false;
    const response = await this.fetcher(new URL('/api/internal/authorization/check/', this.accountApiOrigin ?? principal.issuer), {
      method: 'POST', headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: principal.subject, applicationId: principal.applicationId, credentialVersion: principal.credentialVersion }), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: boolean; data?: { active?: boolean; credentialVersion?: number } };
    return result.success === true && result.data?.active === true && result.data.credentialVersion === principal.credentialVersion;
  }
}
