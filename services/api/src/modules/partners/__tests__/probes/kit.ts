// C13 T22 probe kit (tester-owned fixture, not a test file). Spec-driven generators + a recording request context for the security probes of 07-SECURITY §6.
// Everything is derived from contracts/openapi/partners.yaml, so a new operationId is picked up (and must be classified) without editing the tests.
// Synthetic data only.
import { join } from 'node:path';
import { LimsError } from '../../../../core/errors.js';
import { loadSpec, operationIds, REPO_ROOT } from '../../../../core/module.js';

export const SPEC: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'partners.yaml'));
export const OPS: string[] = operationIds(SPEC);

export interface Op { operationId: string; method: string; path: string; permission: string; op: any; staff: boolean }
/** every operation of partners.yaml; `staff` = under /v1/partners/admin/ (staff BFF), else partner-facing. */
export const ALL: Op[] = Object.entries<any>(SPEC.paths).flatMap(([path, item]) =>
  Object.entries<any>(item).filter(([, op]) => op?.operationId).map(([method, op]) => ({
    operationId: op.operationId as string, method: method.toUpperCase(), path, permission: op['x-permission'] as string, op, staff: path.startsWith('/v1/partners/admin/'),
  })));
export const PARTNER_OPS = ALL.filter((o) => !o.staff);
export const STAFF_OPS = ALL.filter((o) => o.staff);
/** Operations that still have no owning task in 06-IMPLEMENTATION-PLAN (settings SA11/SA12): stubs that must fail closed. Move out of this list when implemented. */
export const UNOWNED_STUBS = ['getPartnerSettings', 'updatePartnerSettings'];

const UUID = '01940e00-0000-7000-8000-c13220000001';
/** a path-param-complete request whose ids exist nowhere */
export function reqFor(o: Op, extra: Partial<{ query: object; headers: object; body: unknown }> = {}) {
  const params: Record<string, string> = {};
  for (const m of o.path.matchAll(/\{([^}]+)\}/g)) params[m[1]!] = m[1] === 'version_no' ? '1' : m[1] === 'period_month' ? '2026-01' : UUID;
  return { params, query: {}, headers: {}, body: undefined as unknown, ...extra };
}

export type ActorType = 'user' | 'system' | 'device' | 'portal' | 'patient' | 'partner';
export const WRONG_FOR_PARTNER_OPS: ActorType[] = ['user', 'device', 'portal', 'patient'];
export const WRONG_FOR_STAFF_OPS: ActorType[] = ['partner', 'device', 'portal', 'patient'];

export const ids = { tenant: '01940e00-0000-7000-8000-c13220000a01', actor: '01940e00-0000-7000-8000-c13220000a02', membership: '01940e00-0000-7000-8000-c13220000a03' };

/** One request context that records every SQL text, port call, log line and metric. `rows` answers the partner-context lookup (active partner) when `activePartner`. */
export function recCtx(actorType: ActorType, o: { activePartner?: boolean; portal?: Record<string, (...a: any[]) => any> } = {}) {
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const portCalls: string[] = [];
  const logs: string[] = [];
  const metrics: Array<{ name: string; labels: object }> = [];
  const audit: any[] = [];
  const tx = {
    async query(text: string, values: unknown[] = []) {
      sql.push({ text, values });
      if (o.activePartner && /FROM partners\.partner_users pu/i.test(text)) {
        return { rows: [{ partner_user_id: ids.actor, partner_id: '01940e00-0000-7000-8000-c13220000b01', partner_role: 'partner_admin', user_status: 'active', partner_status: 'active',
          display_name: 'Synthetic Probe', partner_code: 'SYN-PROBE', partner_name: 'Synthetic Probe Partner', conversion_mode: 'on_receipt', access_slip_enabled: true, include_default_price_list: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  // C2 would deny a wrong actor type; the fake does the same so a handler that calls assertRole first still ends in 403.
  const identity = {
    async assertRole(_c: any, _r: any) { portCalls.push('IdentityPort.assertRole'); if (actorType !== 'user' && actorType !== 'partner') throw new LimsError('auth.forbidden'); },
    async getTenantSettings() { portCalls.push('IdentityPort.getTenantSettings'); return { timezone: 'Asia/Kathmandu', retentionYears: 5 }; },
  };
  const ports: any = new Proxy({ IdentityPort: identity, ...(o.portal ?? {}) }, {
    get(t: any, name: string) {
      if (name in t) return t[name];
      return new Proxy({}, { get: (_x, m: string) => async () => { portCalls.push(`${name}.${m}`); throw new LimsError('common.not_found'); } });
    },
  });
  const log = (x: unknown) => { logs.push(JSON.stringify(x)); };
  const ctx: any = {
    tenantId: ids.tenant, actor: { type: actorType, id: ids.actor, membershipId: ids.membership }, requestId: ids.actor, tx, now: () => '2026-11-14T06:00:00.000Z',
    operationId: 'probe', clientIp: '203.0.113.7', db: {}, core: {}, events: {}, uploads: {}, files: {}, storage: {}, services: {}, download: {}, noRetry() {}, commitOnError() {},
    audit: { async access(e: any) { audit.push(structuredClone(e)); } },
    rateLimit: { async consume() {} },
    metrics: { inc: (name: string, labels: object = {}) => { metrics.push({ name, labels }); }, observe: () => undefined, set: () => undefined },
    log: { info: log, warn: log, error: log, debug: log, child: () => ctx.log },
    ports,
  };
  const writes = () => sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.text) || /enqueue_job/i.test(s.text));
  return { ctx, sql, portCalls, logs, metrics, audit, writes };
}

/** Runs a handler and returns the thrown LimsError-ish (or the result). */
export async function settle(p: Promise<any>): Promise<{ ok: true; value: any } | { ok: false; error: any }> {
  return p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
}
