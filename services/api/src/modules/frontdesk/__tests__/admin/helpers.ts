// FD-T15 harness (F7 anonymisePatient, F24 get/updateFrontdeskSettings, F25 listFrontdeskCodes, F26 listPossibleDuplicatePatients).
// Same convention as ../approvals/helpers.ts (FD-T07) and ../trf/helpers.ts (FD-T10): handlers are driven with a request-shaped object + a HandlerContext over a REAL PG17 tx
// (lims_api, RLS on; `bypassRls` = superuser tx so only the repo's own explicit tenant_id filter can keep tenants apart). The core pipeline (schema validation, auth, x-permission,
// Idempotency-Key replay) is NOT re-tested here; the privileged/aal2 rule is modelled by the IdentityPort fake exactly like packages/fakes IdentityPort.fake.ts `assertRole`
// (no grant -> auth.forbidden; privileged permission at aal1 -> auth.mfa_required; centre outside scope -> auth.forbidden).
// Privileged here (02-TRD §7 / 07-SECURITY REQ-SEC-062/067, contracts permissions): frontdesk.settings.manage, frontdesk.patient.anonymise.
// ASSUMED ctx (spec names no frontdesk ctx; 02-TRD §6.4, AF §2.18): ctx.tenantId, tx, requestId, now(), centreId, actor, audit.access (REAL core/audit/access.ts),
// ctx.ports.IdentityPort{assertRole,getActor,getTenantSettings} (getTenantSettings carries `retentionYears`, TRD §6), ctx.storage (fake object store; F7 deletes TRF objects with
// ctx.storage.delete(bucket, path) — AF §2.18, 08 A13 P-12 c / D-27 b). Synthetic data only.
import { access } from '../../../../core/audit/access.js';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../../handlers/index.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, TENANT_SETTINGS, T, accessRows, appTx, ownerRows, patientRow, rejection, req, schemaErrors, seed, seedOrder, seedPatient, seedSettings, superTx, tag, uid, phone } from '../patients/helpers.js';
import { makeWorld, seedTrf, type World } from '../trf/helpers.js';

export { BRANCH, CENTRE, NOW, T, TENANT_A, TENANT_B, accessRows, ownerRows, patientRow, rejection, req, schemaErrors, seed, seedOrder, seedPatient, seedSettings, superTx, tag, uid, phone, makeWorld, seedTrf };
export type { World };

export const P = {
  settings: 'frontdesk.settings.manage', anonymise: 'frontdesk.patient.anonymise', create: 'frontdesk.registration.create',
  patientRead: 'frontdesk.patient.read', orderRead: 'frontdesk.order.read', orderEdit: 'frontdesk.order.edit',
} as const;
const PRIVILEGED: ReadonlySet<string> = new Set([P.settings, P.anonymise]);
export const mid = (side: 'a' | 'b', n: number): string => `01a1a98a-ac40-7000-8000-00000000${side}${n}`;

export interface Who { tenant: string; membershipId: string; grants: readonly string[]; mfa: 'aal1' | 'aal2'; centreIds: readonly string[]; retentionYears?: number; allCentres?: boolean }
/** tenant_admin at aal2: the only default holder of settings.manage and patient.anonymise (TRD §7). */
export const ADMIN: Who = { tenant: TENANT_A, membershipId: mid('a', 500), grants: [P.settings, P.anonymise, P.patientRead, P.orderRead, P.create], mfa: 'aal2', centreIds: [CENTRE.a], allCentres: true };
export const ADMIN_B: Who = { tenant: TENANT_B, membershipId: mid('b', 501), grants: [P.settings, P.anonymise, P.patientRead, P.orderRead, P.create], mfa: 'aal2', centreIds: [CENTRE.b], allCentres: true };
/** front desk operator: registration.create + reads, no admin permission. */
export const DESK: Who = { tenant: TENANT_A, membershipId: mid('a', 501), grants: [P.create, P.patientRead, P.orderRead], mfa: 'aal1', centreIds: [CENTRE.a] };
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

function identityOf(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && w.mfa !== 'aal2') throw new LimsError('auth.mfa_required');
      if (r.centreId && !w.centreIds.includes(r.centreId)) throw new LimsError('auth.forbidden');
    },
    async getActor() {
      return { actor: { type: 'user', id: SYS_ACTOR, membershipId: w.membershipId }, displayName: 'Synthetic Admin (SYNTHETIC)', roles: [], permissions: [...w.grants],
        centreScope: { all: w.allCentres === true, centreIds: w.centreIds }, branchIds: [BRANCH.a], mfa: { enrolled: w.mfa === 'aal2', level: w.mfa }, isLocked: false };
    },
    async getTenantSettings() { return { ...TENANT_SETTINGS, ...(w.retentionYears === undefined ? {} : { retentionYears: w.retentionYears }) }; },
  };
}

export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: { logs: string[]; accessCalls: any[]; identity: ReturnType<typeof identityOf>; requestId: string; w: World; ctx: any } }
export interface OpOpts { now?: Date; w?: World; requestId?: string; bypassRls?: boolean }
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

/** One request = one committed tx with `who.tenant`'s claims (RLS on unless `bypassRls`). */
export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  const w = o.w ?? makeWorld(who.tenant);
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const probe: Reply['probe'] = { logs: [], accessCalls: [], identity: identityOf(who), requestId: o.requestId ?? uid(), w, ctx: undefined };
  const run = async (tx: any) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => o.now ?? NOW, centreId: CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      ports: { IdentityPort: probe.identity }, storage: w.storage.adapter,
    };
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    probe.ctx = ctx;
    return H[operationId]!(r, ctx);
  };
  const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
  return { ...(out as any), probe };
}
export const opFails = (operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}) => rejection(op(operationId, r, who, o));

// ---- F24 / F25 / F26 / F7 wrappers ----
export const getSettings = (who: Who = ADMIN, o: OpOpts = {}) => op('getFrontdeskSettings', req(), who, o);
export const putSettings = (body: unknown, ifMatch: string | undefined, who: Who = ADMIN, o: OpOpts = {}) =>
  op('updateFrontdeskSettings', req({ body, headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } }), who, o);
export const putSettingsFails = (body: unknown, ifMatch: string | undefined, who: Who = ADMIN, o: OpOpts = {}) => rejection(putSettings(body, ifMatch, who, o));
export const codes = (setName: string, who: Who = DESK, o: OpOpts = {}) => op('listFrontdeskCodes', req({ params: { set_name: setName } }), who, o);
export const duplicates = (query: Record<string, unknown>, who: Who = DESK, o: OpOpts = {}) => op('listPossibleDuplicatePatients', req({ query }), who, o);
export const duplicatesFails = (query: Record<string, unknown>, who: Who = DESK, o: OpOpts = {}) => rejection(duplicates(query, who, o));
export const anonymise = (patientId: string, ifMatch: string | undefined, body: unknown = { reason_code: 'patient_request' }, who: Who = ADMIN, o: OpOpts = {}) =>
  op('anonymisePatient', req({ params: { patient_id: patientId }, body, headers: { 'idempotency-key': uid(), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) } }), who, o);
export const anonymiseFails = (patientId: string, ifMatch: string | undefined, body: unknown = { reason_code: 'patient_request' }, who: Who = ADMIN, o: OpOpts = {}) =>
  rejection(anonymise(patientId, ifMatch, body, who, o));

// ---- settings fixtures ----
/** The seeded baseline (patients/helpers seedSettings: consent 'v1', min chars 3) restored to version 1 before each settings test. */
export const BASE_SETTINGS = {
  discount_self_limit_bp: 0, discount_self_limit_paisa: 0, discount_absolute_max_bp: 10000, require_referrer: false, consent_text_version: 'v1',
  registration_sms_enabled: true, label_autoprint: true, buyer_pan_pattern: '^[0-9]{9}$', patient_search_min_chars: 3,
};
/** A full, valid PUT body that differs from BASE_SETTINGS in every field. */
export const NEW_SETTINGS = {
  discount_self_limit_bp: 500, discount_self_limit_paisa: 100000, discount_absolute_max_bp: 2000, require_referrer: true, consent_text_version: 'v1',
  registration_sms_enabled: false, label_autoprint: false, buyer_pan_pattern: '^[0-9]{10}$', patient_search_min_chars: 4,
};
export async function resetSettings(): Promise<void> {
  await seedSettings();
  for (const t of [TENANT_A, TENANT_B]) {
    await superTx(async (tx) => {
      await tx.query(`UPDATE frontdesk.settings SET discount_self_limit_bp = 0, discount_self_limit_paisa = 0, discount_absolute_max_bp = 10000, require_referrer = false,
        consent_text_version = 'v1', registration_sms_enabled = true, label_autoprint = true, buyer_pan_pattern = '^[0-9]{9}$', patient_search_min_chars = 3, version = 1
        WHERE tenant_id = $1`, [t]);
    }, t);
  }
}
export const settingsRow = async (tenant: string) => (await ownerRows('frontdesk.settings', 'tenant_id = $1', [tenant]))[0];

// ---- anonymise fixtures ----
export const YEAR_MS = 365.2425 * 24 * 3600 * 1000;
/** ISO instant `years` calendar years before NOW (UTC fields; Asia/Kathmandu has no DST so the instant arithmetic is the same in the tenant zone), shifted by `plusMs`. */
export function yearsAgo(years: number, plusMs = 0): string {
  const d = new Date(NOW.getTime()); d.setUTCFullYear(d.getUTCFullYear() - years);
  return new Date(d.getTime() + plusMs).toISOString();
}
/** Demographic values that must never appear in audit rows / logs / access-log detail. */
export interface Sentinels { name: string; phone: string; email: string; address: string; birth: string }
export interface Anonymisable { patient: any; w: World; sent: Sentinels; orders: any[]; trfs: any[]; control: { patient: any; trf: any } }
/** A patient with unique demographic sentinels, cancelled orders registered at the given instants (cancelled = never "open", no LabPort needed), clean TRFs with objects in the fake store,
 *  and an untouched control patient (own order + TRF) of the same tenant. */
export async function anonymisable(o: { orderAt?: string[]; trfPerOrder?: number; row?: Record<string, unknown> } = {}): Promise<Anonymisable> {
  const w = makeWorld(TENANT_A);
  const t = tag();
  const sent: Sentinels = { name: `Zanon ${t} Sentinel`, phone: phone(), email: `anon.${t}@example.invalid`, address: `Sentinel Lane ${t} Ward 7`, birth: '1980-02-03' };
  const patient = await seedPatient('a', { full_name: sent.name, phone_e164: sent.phone, email: sent.email, address_text: sent.address, birth_on: sent.birth, ...(o.row ?? {}) },
    { sms: true, whatsapp: true, email: true, share_with_referrer: true });
  const orders: any[] = []; const trfs: any[] = [];
  for (const at of o.orderAt ?? [yearsAgo(6)]) {
    const order = await seedOrder('a', patient.id, { status: 'cancelled', registered_at: at, cancelled_at: at, cancel_reason_code: 'patient_request' });
    orders.push(order);
    for (let i = 0; i < (o.trfPerOrder ?? 1); i++) trfs.push(await seedTrf(w, { orderId: order.id }));
  }
  const cp = await seedPatient('a', {});
  const co = await seedOrder('a', cp.id, { status: 'cancelled', registered_at: yearsAgo(6), cancelled_at: yearsAgo(6), cancel_reason_code: 'patient_request' });
  const ct = await seedTrf(w, { orderId: co.id });
  return { patient, w, sent, orders, trfs, control: { patient: cp, trf: ct } };
}
export const consentsOf = async (patientId: string) => ownerRows('frontdesk.patient_consents', 'patient_id = $1 ORDER BY captured_at, created_at, id', [patientId]);
export const ordersOf = async (patientId: string) => ownerRows('frontdesk.orders', 'patient_id = $1 ORDER BY id', [patientId]);
export const trfsOfPatient = async (patientId: string) => ownerRows('frontdesk.trf_attachments', 'order_id IN (SELECT id FROM frontdesk.orders WHERE patient_id = $1) ORDER BY id', [patientId]);
/** audit.audit_log rows (any table of the tenant) whose JSON text contains `needle` (LIKE wildcards escaped). */
export async function auditRowsContaining(needle: string, tenant = TENANT_A): Promise<any[]> {
  const esc = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  return superTx(async (tx) => (await tx.query(`SELECT id, schema_name, table_name, row_id, action FROM audit.audit_log a WHERE tenant_id = $1 AND to_jsonb(a)::text LIKE '%' || $2 || '%'`, [tenant, esc])).rows, tenant);
}
