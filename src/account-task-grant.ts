import { createHash } from 'node:crypto';
import { canonicalAccountIssuer, isValidAccountAuthorizationId } from './auth.js';
import { DomainError, type Principal } from './contracts.js';
import type { AccountTaskGrant } from './domain.js';

export type AccountTaskGrantAdmission = Omit<AccountTaskGrant, 'rootTaskId' | 'delegationExpiresAt'>;

export function isAccountIdentity(
  principal: Principal,
  binding?: { expectedIssuer: string; expectedAudience: string },
): boolean {
  const { issuer, subject } = principal;
  let canonicalIssuer: string | undefined;
  try {
    canonicalIssuer = issuer ? canonicalAccountIssuer(issuer) : undefined;
  } catch {
    canonicalIssuer = undefined;
  }
  return Boolean(Array.isArray(principal.scopes)
    && principal.scopes.every((scope) => typeof scope === 'string')
    && subject?.match(/^acct_[0-9a-f]{32}$/)
    && issuer
    && issuer === canonicalIssuer
    && principal.id === createHash('sha256').update(`${issuer}\0${subject}`).digest('hex')
    && principal.applicationId
    && principal.audience
    && isValidAccountAuthorizationId(principal.authorizationId)
    && Number.isInteger(principal.credentialVersion)
    && principal.credentialVersion! >= 0
    && Number.isInteger(principal.consentVersion)
    && principal.consentVersion! > 0
    && (principal.grantVersion === undefined
      || (Number.isSafeInteger(principal.grantVersion) && principal.grantVersion > 0))
    && (principal.grantVersion === undefined || principal.authenticatedAt !== undefined)
    && (principal.authenticatedAt === undefined
      || (Number.isSafeInteger(principal.authenticatedAt) && principal.authenticatedAt > 0))
    && (!binding || (issuer === binding.expectedIssuer && principal.audience === binding.expectedAudience)));
}

export function bindAccountTaskGrant(
  principal: Principal,
  admission: AccountTaskGrantAdmission,
  rootTaskId: string,
): { principal: Principal; grant: AccountTaskGrant } {
  if (!validScopes(admission.scopes)) {
    throw new DomainError('invalid_account_task_grant', 'Account task authorization context is invalid', 403);
  }
  const scopes = normalizedScopes(admission.scopes);
  const grant: AccountTaskGrant = {
    issuer: admission.issuer,
    subject: admission.subject,
    applicationId: admission.applicationId,
    audience: admission.audience,
    ...(admission.authorizationId === undefined ? {} : { authorizationId: admission.authorizationId }),
    credentialVersion: admission.credentialVersion,
    consentVersion: admission.consentVersion,
    ...(admission.grantVersion === undefined ? {} : { grantVersion: admission.grantVersion }),
    ...(admission.authenticatedAt === undefined ? {} : { authenticatedAt: admission.authenticatedAt }),
    scopes,
    rootTaskId,
  };
  if (!rootTaskId || !matchesIdentity(grant, principal)
    || !sameScopes(scopes, normalizedScopes(principal.scopes))) {
    throw new DomainError('invalid_account_task_grant', 'Account task authorization context is invalid', 403);
  }
  const { expiresAt: _expiresAt, ...durable } = principal;
  return { principal: { ...durable, scopes }, grant };
}

export function accountTaskGrantMatches(
  grant: AccountTaskGrant,
  principal: Principal,
  rootTaskId: string,
): boolean {
  if (!validScopes(grant.scopes) || !validDelegationExpiry(grant.delegationExpiresAt)) return false;
  const scopes = normalizedScopes(grant.scopes);
  return principal.expiresAt === undefined
    && grant.rootTaskId === rootTaskId
    && sameScopes(grant.scopes, scopes)
    && matchesIdentity(grant, principal)
    && sameScopes(scopes, principal.scopes);
}

export function repairableAccountTaskGrant(
  grant: AccountTaskGrant,
  principal: Principal,
  rootTaskId: string,
): boolean {
  const { expiresAt: _expiresAt, ...durable } = principal;
  return accountTaskGrantMatches(grant, durable, rootTaskId);
}

export function narrowAccountTaskGrant(
  grant: AccountTaskGrant,
  principal: Principal,
  delegationExpiresAt?: string,
): AccountTaskGrant {
  if (!validScopes(grant.scopes) || !validDelegationExpiry(grant.delegationExpiresAt)
    || !validDelegationExpiry(delegationExpiresAt)) {
    throw new DomainError('invalid_account_task_grant', 'Account task authorization context is invalid', 403);
  }
  if (!principal.scopes.every((scope) => scopeCovered(grant.scopes, scope))) {
    throw new DomainError('scope_expansion', 'Child scopes must be covered by the parent account task grant', 403);
  }
  if (grant.delegationExpiresAt && delegationExpiresAt
    && Date.parse(delegationExpiresAt) > Date.parse(grant.delegationExpiresAt)) {
    throw new DomainError('grant_expansion', 'Child grant cannot outlive its parent', 403);
  }
  return {
    ...grant,
    scopes: normalizedScopes(principal.scopes),
    ...(delegationExpiresAt ? { delegationExpiresAt } : {}),
  };
}

export function accountTaskGrantIdentityMatches(grant: AccountTaskGrant, principal: Principal): boolean {
  return matchesIdentity(grant, principal);
}

function matchesIdentity(grant: AccountTaskGrant | AccountTaskGrantAdmission, principal: Principal): boolean {
  return isAccountIdentity(principal)
    && grant.issuer === principal.issuer
    && grant.subject === principal.subject
    && grant.applicationId === principal.applicationId
    && grant.audience === principal.audience
    && grant.authorizationId === principal.authorizationId
    && grant.credentialVersion === principal.credentialVersion
    && grant.consentVersion === principal.consentVersion
    && grant.grantVersion === principal.grantVersion
    && grant.authenticatedAt === principal.authenticatedAt;
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

function validScopes(scopes: unknown): scopes is string[] {
  return Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string');
}

function validDelegationExpiry(expiresAt: unknown): expiresAt is string | undefined {
  if (expiresAt === undefined) return true;
  if (typeof expiresAt !== 'string') return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === expiresAt;
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function scopeCovered(grants: readonly string[], requested: string): boolean {
  const namespace = requested.split(':')[0];
  return grants.some((grant) => grant === '*'
    || grant === 'kiancode:*'
    || grant === requested
    || grant === `kiancode:${requested}`
    || grant === `${namespace}:*`);
}
