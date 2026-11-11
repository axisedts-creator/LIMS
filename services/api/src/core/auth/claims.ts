// DbClaims for request.jwt.claims (02-TRD §6.4): built only from claimsResolver / AuthResolver output, never request input (REQ-SEC-013).
import type { ModuleName } from '../module.js';
import { AuthError, internal } from './errors.js';

export type ActorType = 'user' | 'system' | 'device' | 'portal' | 'patient' | 'partner';
const ACTOR_TYPES: readonly string[] = ['user', 'system', 'device', 'portal', 'patient', 'partner'];

/** 02-TRD §6.4. */
export interface DbClaims {
  sub: string; tenant_id?: string; membership_id?: string; centre_id?: string;
  actor_type: ActorType;
  aal?: 'aal1' | 'aal2'; support_session_id?: string;
  lims_session_id?: string; session_state?: string;
  scope?: 'platform' | 'support'; platform_staff_id?: string; platform_role?: string; support_scope?: string;
  [extra: string]: unknown;
}

/** C2 02-TRD §6.1 (only the fields core reads are typed). */
export type ResolvedClaims =
  | { readonly kind: 'tenant' | 'platform' | 'partner' | 'patient' | 'staff_mobile'; readonly claimsJson: string; readonly tenantId?: string; readonly actor: unknown; readonly [k: string]: unknown }
  | { readonly kind: 'rejected'; readonly code: string };

const SESSION_KINDS: readonly string[] = ['tenant', 'platform', 'partner', 'patient', 'staff_mobile'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Parses the identity claimsResolver's claimsJson (a fresh object per call). `rejected` throws its code verbatim. */
export function buildDbClaims(resolved: ResolvedClaims): DbClaims {
  if (!isObj(resolved)) throw internal();
  if (resolved.kind === 'rejected') {
    if (!isStr(resolved.code)) throw internal();
    throw new AuthError(resolved.code);
  }
  if (!SESSION_KINDS.includes(resolved.kind as string) || typeof resolved.claimsJson !== 'string') throw internal();
  let c: unknown;
  try {
    c = JSON.parse(resolved.claimsJson); // JSON.parse makes "__proto__" an own key; Object.prototype is never touched
  } catch {
    throw internal();
  }
  if (!isObj(c) || !isStr(c.sub) || !ACTOR_TYPES.includes(c.actor_type as string)) throw internal();
  return c as DbClaims;
}

/** extraClaims keys each module may set (02-TRD §6.3, 08 §4.11). */
const EXTRA_CLAIMS: Readonly<Partial<Record<ModuleName, readonly string[]>>> = {
  reporting: ['portal_stage', 'portal_report_id', 'portal_session_id', 'portal_link_purpose'],
  instruments: ['credential_kind', 'credential_id'],
  payments: ['payment_intent_id'],
  engagement: ['patient_stage', 'otp_token_sha256', 'device_kind'],
};
const RESOLVER_ACTORS: readonly string[] = ['device', 'portal', 'patient', 'system'];

/** AuthResolver ok-result -> DbClaims { sub, tenant_id, actor_type, centre_id?, ...allowlisted extraClaims }. Throws on anything else. */
export function buildAuthResolverClaims(moduleName: ModuleName, ok: unknown): DbClaims {
  if (!isObj(ok) || !isStr(ok.tenantId) || !isObj(ok.actor) || !isStr(ok.actor.id) || !RESOLVER_ACTORS.includes(ok.actor.type as string)) throw internal();
  if (ok.centreId !== undefined && !isStr(ok.centreId)) throw internal();
  const allowed = EXTRA_CLAIMS[moduleName] ?? [];
  const extra = ok.extraClaims ?? {};
  if (!isObj(extra)) throw internal();
  const out: DbClaims = { sub: ok.actor.id, tenant_id: ok.tenantId, actor_type: ok.actor.type as ActorType };
  if (ok.centreId !== undefined) out.centre_id = ok.centreId;
  for (const k of Reflect.ownKeys(extra)) {
    // reserved claims (tenant_id, sub, scope, __proto__, ...) are never in an allowlist, so they cannot be injected
    if (typeof k !== 'string' || !allowed.includes(k) || typeof extra[k] !== 'string') throw internal();
    out[k] = extra[k];
  }
  return out;
}
