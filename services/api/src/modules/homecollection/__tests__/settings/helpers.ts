// HC-T04 harness (H18 getHomecollectionSettings, H19 updateHomecollectionSettings, H20 listHomecollectionReasons).
// Same convention as frontdesk FD-T15 (../../../frontdesk/__tests__/admin/helpers.ts): the handler under test is taken from the module manifest and driven with a request-shaped
// object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on; `bypassRls` = superuser tx so only the repo's own explicit tenant_id filter can keep tenants apart).
// The core pipeline (schema validation, auth, x-permission, Idempotency-Key) is NOT re-tested here; the privileged/aal2 rule is modelled by an IdentityPort fake exactly like
// packages/fakes IdentityPort.fake.ts `assertRole` (no grant -> auth.forbidden; privileged permission at aal1 -> auth.mfa_required).
// ASSUMED ctx (as FD-T15, 02-TRD §6.4): ctx.tenantId, tx, requestId, now(), centreId, actor, ctx.ports.IdentityPort.assertRole. Synthetic data only.
// Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T04.pg.sh.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { HC_CENTRE, MEMBER, SYS_ACTOR, TENANT_A, TENANT_B, appTx, hc, ownerRows, superTx, uid } from '../../repository/__tests__/helpers.js';

export { HC_CENTRE, MEMBER, SYS_ACTOR, TENANT_A, TENANT_B, ownerRows, superTx, uid };
export const T = 60_000;
export const NOW = new Date('2026-11-10T06:00:00.000Z');

export const P = { settings: 'homecollection.settings.manage', read: 'homecollection.visit.read', assign: 'homecollection.visit.assign', sync: 'homecollection.sync.upload' } as const;
const PRIVILEGED: ReadonlySet<string> = new Set([P.settings, 'homecollection.device.manage']);   // CR-C17-008 `privileged: true`

// ---- contract validators (contracts/openapi/homecollection.yaml) ----
export const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/homecollection.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const errs = (v: any, x: unknown): string[] => (v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`));
export const schemaErrors = (name: string, x: unknown): string[] => errs(ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }), x);
export const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
/** Validate `x` against the 200 response schema of an operation (H20 has an inline schema). */
export const responseErrors = (operationId: string, x: unknown): string[] =>
  errs(ajv.compile({ ...opOf(operationId).responses['200'].content['application/json'].schema, components: spec.components }), x);

// ---- who calls ----
export interface Who { tenant: string; membershipId: string; grants: readonly string[]; mfa: 'aal1' | 'aal2' }
const mid = (side: 'a' | 'b', n: number) => `01a1a98a-ac40-7000-8000-00000000${side}${n}`;
/** lab_manager / tenant_admin at aal2: settings.manage (privileged) + visit.read. */
export const ADMIN: Who = { tenant: TENANT_A, membershipId: mid('a', 500), grants: [P.settings, P.read], mfa: 'aal2' };
export const ADMIN_B: Who = { tenant: TENANT_B, membershipId: mid('b', 500), grants: [P.settings, P.read], mfa: 'aal2' };
/** dispatcher: visit.read + visit.assign, no settings.manage. */
export const DISPATCHER: Who = { tenant: TENANT_A, membershipId: mid('a', 501), grants: [P.read, P.assign], mfa: 'aal1' };
/** phlebotomist: sync.upload only. */
export const PHLEBO: Who = { tenant: TENANT_A, membershipId: mid('a', 502), grants: [P.sync], mfa: 'aal2' };
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

function identityOf(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && w.mfa !== 'aal2') throw new LimsError('auth.mfa_required');
    },
    async getActor() {
      return { actor: { type: 'user', id: SYS_ACTOR, membershipId: w.membershipId }, displayName: 'Synthetic Admin (SYNTHETIC)', roles: [], permissions: [...w.grants],
        centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: w.mfa === 'aal2', level: w.mfa }, isLocked: false };
    },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
  };
}

export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection, got success'); };
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: { logs: string[]; identity: ReturnType<typeof identityOf>; requestId: string } }
export interface OpOpts { bypassRls?: boolean }
const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

/** One request = one committed tx with `who.tenant`'s claims (RLS on unless `bypassRls`). */
export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const probe: Reply['probe'] = { logs: [], identity: identityOf(who), requestId: uid() };
  const run = async (tx: any) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId }, ports: { IdentityPort: probe.identity },
    };
    return H[operationId]!(r, ctx);
  };
  const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
  return { ...(out as any), probe };
}
export const getSettings = (who: Who = ADMIN, o: OpOpts = {}) => op('getHomecollectionSettings', req(), who, o);
export const getSettingsFails = (who: Who = ADMIN, o: OpOpts = {}) => rejection(getSettings(who, o));
export const putSettings = (body: unknown, ifMatch: string | undefined, who: Who = ADMIN, o: OpOpts = {}) =>
  op('updateHomecollectionSettings', req({ body, headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } }), who, o);
export const putSettingsFails = (body: unknown, ifMatch: string | undefined, who: Who = ADMIN, o: OpOpts = {}) => rejection(putSettings(body, ifMatch, who, o));
export const reasons = (set: unknown, who: Who = DISPATCHER, o: OpOpts = {}) => op('listHomecollectionReasons', req({ query: set === undefined ? {} : { set } }), who, o);
export const reasonsFails = (set: unknown, who: Who = DISPATCHER, o: OpOpts = {}) => rejection(reasons(set, who, o));

// ---- settings fixtures (TRD §11.2) ----
/** TRD §11.2 defaults: what a lazily created row holds and what a read with no row returns (08 A17 P-22). `payment_methods` / `collection_consent_text` are checked by shape (display text is not specified). */
export const DEFAULT_SCALARS = {
  min_app_version: '1.0.0', sync_interval_seconds: 300, offline_purge_hours: 16, capture_gps: false, gps_retention_days: 90, map_handoff_enabled: true,
  manual_barcode_entry_allowed: true, second_identifier: 'phone', collection_consent_text_version: 'hc-consent-v1', handover_confirmation_required: true,
  handover_overdue_hours: 4, max_visits_per_route: 40, notify_phlebotomist_on_assign: false, notify_patient_on_assign: false, clock_tolerance_seconds: 600,
} as const;
export const DEFAULT_PAYMENT_CODES = [{ code: 'cash', requires_reference: false }, { code: 'fonepay_qr', requires_reference: true }, { code: 'esewa', requires_reference: false }, { code: 'khalti', requires_reference: false }];
export const SEED_PAYMENT_CODES = ['cash', 'card', 'esewa', 'khalti', 'fonepay_qr', 'bank_transfer'] as const;   // C4 global seed set (D-128)
export const WIRE = [...Object.keys(DEFAULT_SCALARS), 'collection_consent_text', 'payment_methods'];

/** The existing-row baseline (HC-T03 `hc.settings` + DB defaults): differs from the lazy defaults in consent text and payment methods, so "never overwritten by defaults" is observable. */
export const BASE = { ...DEFAULT_SCALARS, collection_consent_text: 'Synthetic consent text', payment_methods: [{ code: 'cash', display: 'Cash', requires_reference: false }] };
/** A full, valid PUT body that differs from BASE in every field. */
export const NEW = {
  min_app_version: '2.3.4', sync_interval_seconds: 120, offline_purge_hours: 8, capture_gps: true, gps_retention_days: 30, map_handoff_enabled: false,
  manual_barcode_entry_allowed: false, second_identifier: 'phone', collection_consent_text_version: 'hc-consent-v2', collection_consent_text: 'Synthetic consent v2 text',
  payment_methods: [{ code: 'card', display: 'Card', requires_reference: true }, { code: 'esewa', display: 'eSewa', requires_reference: false }],
  handover_confirmation_required: false, handover_overdue_hours: 6, max_visits_per_route: 25, notify_phlebotomist_on_assign: true, notify_patient_on_assign: false,
  clock_tolerance_seconds: 900,
};
export const wire = (row: any) => Object.fromEntries(WIRE.map((k) => [k, row[k]]));

/** Both tenants get the BASE row at version 1, except those listed in `none`, which get NO row (lazy-create paths). */
export async function resetSettings(none: Array<'a' | 'b'> = []): Promise<void> {
  for (const s of ['a', 'b'] as const) {
    const t = s === 'a' ? TENANT_A : TENANT_B;
    await superTx(async (tx) => {
      await tx.query('DELETE FROM homecollection.settings WHERE tenant_id = $1', [t]);
      if (none.includes(s)) return;
      const row: Record<string, unknown> = hc.settings(s);
      const cols = Object.keys(row);
      await tx.query(`INSERT INTO homecollection.settings (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((c) => (c === 'payment_methods' ? JSON.stringify(row[c]) : row[c])));
    }, t);
  }
}
export const settingsRows = async (tenant: string) => ownerRows('homecollection.settings', 'tenant_id = $1', [tenant]);
export const settingsRow = async (tenant: string) => (await settingsRows(tenant))[0];

// ---- reasons fixtures (05-SCHEMA §2; the global seed table is not seeded by db/seeds until P-1 lands, so the test inserts the normative codes, idempotently) ----
export const REASON_SETS: Record<string, string[]> = {
  visit_cancel_reasons: ['patient_request', 'duplicate', 'lab_unavailable', 'address_unreachable', 'booking_cancelled', 'other'],
  unassign_reasons: ['phlebotomist_unavailable', 'rebalance_routes', 'reschedule', 'missed', 'other'],
  visit_fail_reasons: ['patient_not_home', 'address_not_found', 'patient_refused', 'identity_mismatch', 'unable_to_draw', 'other'],
  specimen_not_collected_reasons: ['unable_to_draw', 'patient_declined_tube', 'tube_missing', 'other'],
  revisit_reasons: ['failed_visit', 'partial_collection', 'patient_request', 'other'],
  review_reasons: ['confirmed_with_phlebotomist', 'order_still_valid', 'specimen_destroyed', 'duplicate_draw', 'wrong_patient', 'other'],
  flag_resolutions: ['handled', 'not_needed', 'escalated', 'other'],
  wipe_reasons: ['lost', 'stolen', 'retired', 'reassigned', 'other'],
};
export async function seedReasons(): Promise<void> {
  await superTx(async (tx) => {
    for (const [set, codes] of Object.entries(REASON_SETS)) {
      let i = 0;
      for (const code of codes) {
        await tx.query(`INSERT INTO homecollection.g_cs_reasons (id, set_code, code, display, requires_text, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (set_code, code) DO NOTHING`, [uid(), set, code, `Synthetic ${code.replaceAll('_', ' ')}`, code === 'other', ++i]);
      }
    }
  });
}
export const reasonTableState = async () => superTx(async (tx) => (await tx.query('SELECT set_code, code, display, requires_text, is_active FROM homecollection.g_cs_reasons ORDER BY set_code, code')).rows);
