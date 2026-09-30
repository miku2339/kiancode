import { requireScope, secureAccountApiOrigin } from './auth.js';
import { DomainError, type Principal } from './contracts.js';
import type { Store } from './storage/store.js';

export interface AccessGrant { scopes: string[]; enabled: boolean }
const defaultScopes = ['chat:read', 'chat:write', 'task:read', 'task:write', 'memory:read', 'memory:write', 'agent:read', 'agent:write', 'schedule:read', 'schedule:write', 'model:read', 'notification:read', 'notification:write', 'artifact:read', 'artifact:write', 'workspace:read', 'device:read', 'approval:write'];

export class AccessService {
  private accountApiOrigin?: string;

  constructor(
    private store: Store,
    private ownerSubject?: string,
    private serviceToken?: string,
    private identityMode: 'account' | 'oidc' | 'development' = 'account',
    accountApiUrl?: string,
    private fetcher: typeof fetch = fetch,
  ) {
    if (ownerSubject && (ownerSubject.length > 255 || ownerSubject.includes('\0'))) throw new Error('The Kian owner subject is invalid');
    this.accountApiOrigin = accountApiUrl ? secureAccountApiOrigin(accountApiUrl) : undefined;
  }
  async authorize(identity: Principal): Promise<Principal> {
    if (!identity.issuer || !identity.subject) return identity;
    const grant = await this.store.get<AccessGrant>('access', identity.id, identity.id);
    if (grant && !grant.data.enabled) throw new DomainError('access_revoked', 'Kian access has been revoked', 403);
    const scopes = identity.subject === this.ownerSubject ? ['*'] : grant?.data.scopes ?? defaultScopes;
    return { ...identity, ...(identity.subject === this.ownerSubject ? { level: 1 as const } : {}), scopes };
  }
  async grant(actor: Principal, principalId: string, grant: AccessGrant) {
    requireScope(actor, 'admin:grant');
    const existing = await this.store.get<AccessGrant>('access', principalId, principalId);
    return existing ? this.store.put('access', principalId, principalId, grant, existing.revision) : this.store.create('access', principalId, grant, principalId);
  }
  async validateDelegation(principal: Principal): Promise<boolean> {
    const expiresAt = principal.expiresAt ? Date.parse(principal.expiresAt) : undefined;
    if ((this.identityMode === 'oidc' && expiresAt === undefined)
      || (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) return false;
    const fresh = await this.authorize(principal);
    if (!principal.scopes.every((scope) => fresh.scopes.includes('*') || fresh.scopes.includes(scope))) return false;
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
