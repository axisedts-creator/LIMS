// Identity claimsResolver (02-TRD §6.1/§6.2; CR-C2-005, 08 R10): the sole claims source for every GoTrue JWT.
// One identityAuthTx, one DEFINER call; every claim comes from the DEFINER row or the verified JWT, never from the request.
import { idMetrics } from '../metrics.js';
import { BlockList, isIP } from 'node:net';
import type { ClaimsRequest, ClaimsResolver } from '../../../core/auth/claims-resolver.js';
import type { ResolvedClaims } from '../../../core/auth/claims.js';
import type { VerifiedJwt } from '../../../core/auth/jwt.js';
import type { TxFn, TxInput } from '../../../core/db/tx.js';
import { resolveSessionRow, type ResolveSessionRow } from '../repository/sessions.repo.js';

export interface ClaimsResolverDeps {
  readonly db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
  readonly now?: () => Date;
}

type RejectCode = 'auth.unauthenticated' | 'auth.session_expired' | 'auth.account_locked' | 'identity.tenant_suspended'
  | 'identity.membership_inactive' | 'identity.platform_ip_denied';

const OPERATION = Object.freeze({ module: 'identity', operationId: 'resolveSession', context: 'identity_auth' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KINDS = new Set(['tenant_staff', 'staff_mobile', 'partner', 'patient']);
const PLATFORM_ROLES = new Set(['platform_superadmin', 'platform_support']);
/** §6.2 step 3 kind check: endpoint family -> the only session kind(s) it accepts ('api' accepts every kind). */
const FAMILY_KINDS: Readonly<Record<string, ReadonlySet<string>>> = {
  staff: new Set(['tenant_staff', 'platform']), partner: new Set(['partner']), patient: new Set(['patient']), mobile: new Set(['staff_mobile']),
};
const BFF_KINDS: Readonly<Record<string, ReadonlySet<string>>> = { staff_web: FAMILY_KINDS.staff!, partner: FAMILY_KINDS.partner! };

const reject = (code: RejectCode): ResolvedClaims => ({ kind: 'rejected', code });
/** Missing/unparsable timestamp counts as already elapsed (fail closed). */
const elapsed = (at: Date | string | null, now: number) => {
  const t = at === null || at === undefined ? NaN : new Date(at).getTime();
  return !(t > now);
};

/** pg returns cidr[] as '{a,b}' unless a type parser is registered; accept both. */
export const cidrList = (v: ResolveSessionRow['platform_allowed_cidrs']): string[] => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  const inner = v.replace(/^\{|\}$/g, '').trim();
  return inner ? inner.split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : [];
};

/** US-E6: empty list = no restriction; otherwise the client IP must fall in an entry. Unparsable IP/entry never matches. */
export function ipAllowed(cidrs: string[], clientIp: string): boolean {
  if (cidrs.length === 0) return true;
  let ip = String(clientIp ?? '');
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7); // IPv4-mapped IPv6 from a dual-stack socket
  const fam = isIP(ip);
  if (fam === 0) return false;
  const list = new BlockList();
  for (const c of cidrs) {
    const [net = '', bits] = c.split('/');
    const f = isIP(net);
    if (f === 0) continue;
    try { list.addSubnet(net, bits === undefined ? (f === 4 ? 32 : 128) : Number(bits), f === 4 ? 'ipv4' : 'ipv6'); } catch { /* bad entry: skip */ }
  }
  return list.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

function evaluate(row: ResolveSessionRow | undefined, jwt: VerifiedJwt, req: ClaimsRequest, now: number): ResolvedClaims {
  // step 2
  if (!row) return reject('auth.unauthenticated');
  if (row.revoked_at !== null && row.revoked_at !== undefined) return reject('auth.session_expired');
  if (elapsed(row.idle_expires_at, now) || elapsed(row.absolute_expires_at, now)) return reject('auth.session_expired');

  const kind = row.kind;
  const isPlatform = kind === 'platform';
  if (!isPlatform && !TENANT_KINDS.has(kind)) return reject('auth.unauthenticated');

  let support = false;
  if (isPlatform) {
    if (!row.platform_staff_id || !PLATFORM_ROLES.has(row.platform_role ?? '')) return reject('auth.unauthenticated');
    // DEFINER returns support_* NULL once the support session ended/expired (08 A20.1); re-check expiry defensively
    support = !!row.support_session_id && !!row.support_tenant_id && !!row.support_scope && !elapsed(row.support_expires_at, now);
    if (!ipAllowed(cidrList(row.platform_allowed_cidrs), req.clientIp)) return reject('identity.platform_ip_denied');
  } else {
    if (!row.tenant_id || !row.membership_id || !row.tenant_status) return reject('auth.unauthenticated');
    if (row.tenant_status === 'suspended' || row.tenant_status === 'offboarded') return reject('identity.tenant_suspended');
    if (row.membership_locked !== false) {
      if (row.membership_locked === true) return reject('auth.account_locked');
      return reject('auth.unauthenticated');
    }
    if (row.membership_status !== 'active') return reject('identity.membership_inactive');
    if (kind === 'partner' && !row.partner_role) return reject('auth.unauthenticated');
  }

  // step 3, kind check (identity endpoint families only)
  if (req.endpointFamily !== 'api') {
    const fam = FAMILY_KINDS[req.endpointFamily];
    if (!fam) return reject('auth.unauthenticated');
    if (!fam.has(kind)) return reject('auth.session_expired');
    const byKey = req.bffKey ? BFF_KINDS[req.bffKey] : undefined;
    if (byKey && !byKey.has(kind)) return reject('auth.session_expired');
  }

  // step 4: lowest wins; patient always aal1
  const aal = kind !== 'patient' && jwt.aal === 'aal2' && row.session_aal === 'aal2' ? 'aal2' : 'aal1';
  const sub = jwt.sub;
  const lims_session_id = row.session_id;

  if (isPlatform) {
    const actor = { type: 'user', id: sub, ...(support ? { supportSessionId: row.support_session_id! } : {}) };
    const c = support
      ? { sub, tenant_id: row.support_tenant_id!, actor_type: 'user', scope: 'support', support_session_id: row.support_session_id!,
          support_scope: row.support_scope!, platform_staff_id: row.platform_staff_id!, aal, lims_session_id }
      : { sub, actor_type: 'user', scope: 'platform', platform_staff_id: row.platform_staff_id!, platform_role: row.platform_role!, aal, lims_session_id };
    return { kind: 'platform', claimsJson: JSON.stringify(c), actor, platformRole: row.platform_role! };
  }

  const tenant_id = row.tenant_id!, membership_id = row.membership_id!;
  const actorType = kind === 'partner' ? 'partner' : kind === 'patient' ? 'patient' : 'user';
  const actor = { type: actorType, id: sub, membershipId: membership_id };
  if (kind === 'patient') {
    const c = { sub, tenant_id, membership_id, actor_type: 'patient', aal: 'aal1', lims_session_id, session_state: 'active' };
    return { kind: 'patient', claimsJson: JSON.stringify(c), tenantId: tenant_id, actor };
  }
  const session_state = row.state;
  const c = kind === 'partner'
    ? { sub, tenant_id, membership_id, actor_type: 'partner', partner_role: row.partner_role!, aal, lims_session_id, session_state }
    : { sub, tenant_id, membership_id, actor_type: 'user', aal, lims_session_id, session_state };
  const outKind = kind === 'tenant_staff' ? 'tenant' : (kind as 'partner' | 'staff_mobile');
  return { kind: outKind, claimsJson: JSON.stringify(c), tenantId: tenant_id, actor, sessionState: session_state };
}

export function createClaimsResolver(deps: ClaimsResolverDeps): ClaimsResolver {
  const clock = deps.now ?? (() => new Date());
  return {
    async resolve(jwt: VerifiedJwt, request: ClaimsRequest): Promise<ResolvedClaims> {
      // 08 A13 D-32: the portal BFF key is never accepted on /v1/identity/*
      if (request.bffKey === 'portal' && request.endpointFamily !== 'api') return reject('auth.unauthenticated');
      if (typeof jwt?.sub !== 'string' || typeof jwt.sessionId !== 'string' || !UUID.test(jwt.sub) || !UUID.test(jwt.sessionId)) {
        return reject('auth.unauthenticated');
      }
      const input: TxInput = { requestId: request.requestId, clientIp: request.clientIp, operation: OPERATION };
      const t0 = performance.now();
      try {
        const row = await deps.db.identityAuthTx(input, (tx) => resolveSessionRow(tx, jwt.sessionId, jwt.sub));
        return evaluate(row, jwt, request, clock().getTime());
      } finally {
        idMetrics.claimsResolveSeconds(undefined, (performance.now() - t0) / 1000);   // T28 (02-TRD §13); DB round trip + evaluate
      }
    },
  };
}
