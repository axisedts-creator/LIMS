// FD-T04 harness (C4 Patients F1-F6). Handlers are driven with a request-shaped object + a HandlerContext built over a REAL PG17 tx (lims_api, RLS on),
// the same convention as catalog's *.handlers.test.ts. The core pipeline (schema validation, auth, x-permission, Idempotency-Key replay) is NOT re-tested here.
// ASSUMED ctx shape (handler reads these; spec: 02-TRD §6.4/§6.9, 03-APP-FLOW §2.1, catalog handlers):
//   ctx.tenantId, ctx.tx{query}, ctx.requestId, ctx.actor{type,id,membershipId}, ctx.centreId, ctx.now(), ctx.audit.access(entry),
//   ctx.ports.IdentityPort{assertRole,getActor,getTenantSettings}. audit.access is the REAL core/audit/access.ts writing audit.access_log on ctx.tx.
// Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL (see ../integration/helpers.ts; tests/frontdesk/FD-T04.pg.sh boots PG17 and exports them). Synthetic data only.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { access } from '../../../../core/audit/access.js';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { BRANCH, CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid, type Tx } from '../integration/helpers.js';

export { BRANCH, CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid };
export const CONSENT_VERSION = 'v1';
export const NOW = new Date('2026-11-10T06:00:00.000Z');   // 11:45 Asia/Kathmandu, 2026-11-10 (A.D.)
export const NOW_DATE = '2026-11-10';

export const PERM = {
  read: 'frontdesk.patient.read', create: 'frontdesk.registration.create', orders: 'frontdesk.order.read',
} as const;
export const FULL = [PERM.read, PERM.create, PERM.orders] as const;

export const TENANT_SETTINGS = {
  numbering: { patientCodePattern: 'MP{seq:8}', registrationNoPattern: 'R{seq:6}', barcodePattern: '{seq:8}', invoiceNoPattern: '{fy}-{seq:6}',
    creditNoteNoPattern: 'CN-{fy}-{seq:6}', receiptNoPattern: 'RC-{fy}-{seq:6}' },
  timezone: 'Asia/Kathmandu', channels: { smsEnabled: true, whatsappEnabled: false, emailEnabled: false },
};

// ---- spec validators ----
export const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
export const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`);
};
export const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

// ---- fake IdentityPort (permissions drive BOTH assertRole and getActor.permissions) ----
export function makeIdentity(grants: readonly string[], opts: { displayName?: string; centreIds?: readonly string[] } = {}) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_ctx: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (!grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
    },
    async getActor() {
      return { actor: { type: 'system', id: SYS_ACTOR }, displayName: opts.displayName ?? 'Synthetic Operator', roles: ['front_desk'], permissions: [...grants],
        centreScope: { all: false, centreIds: opts.centreIds ?? [CENTRE.a] }, branchIds: [BRANCH.a], mfa: { enrolled: true, level: 'aal1' }, isLocked: false };
    },
    async getTenantSettings() { return TENANT_SETTINGS; },
  };
}
export type FakeIdentity = ReturnType<typeof makeIdentity>;

export interface Probe { logs: string[]; accessCalls: any[]; identity: FakeIdentity; membershipId: string; requestId: string; ctx: any }
export type Reply = { status: number; body?: any; headers?: Record<string, string> };
const H = handlers as unknown as Record<string, (req: any, ctx: any) => Promise<Reply>>;
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });

/** One request = one committed tx under RLS with `claimsTenant` claims; `tenantId` is what the handler sees as ctx.tenantId (normally the same). */
export async function call(operationId: string, r: ReturnType<typeof req>, o: { grants?: readonly string[]; tenant?: string; tenantId?: string; requestId?: string; fn?: (tx: Tx) => Promise<void> } = {}): Promise<Reply & { probe: Probe }> {
  const grants = o.grants ?? FULL;
  const tenant = o.tenant ?? TENANT_A;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const probe = { logs: [] as string[], accessCalls: [] as any[], identity: makeIdentity(grants, { centreIds: [CENTRE[side]] }), membershipId: uid(), requestId: o.requestId ?? uid() } as Probe;
  const out = await appTx(tenant, async (tx) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') },
      tenantId: o.tenantId ?? tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: CENTRE[side],
      actor: { type: 'system', id: SYS_ACTOR, membershipId: probe.membershipId },
      ports: { IdentityPort: probe.identity },
    };
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    probe.ctx = ctx;
    return H[operationId]!(r, ctx);
  });
  return { ...out, probe };
}
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection, got success'); };
export const fails = async (operationId: string, r: ReturnType<typeof req>, o: Parameters<typeof call>[2] = {}) => rejection(call(operationId, r, o));

// ---- data builders ----
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
export const tag = () => Array.from({ length: 8 }, () => 'bcdfghjklmnpqrstvwxz'[Math.floor(Math.random() * 20)]).join('');
export const phone = () => `+97798${digits(8)}`;
export const national = (p: string) => p.replace('+977', '');
export const consents = (o: Record<string, unknown> = {}) => ({ processing: true, sms: true, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: CONSENT_VERSION, ...o });
export const newPatient = (o: Record<string, unknown> = {}) => ({ full_name: `Fdt Four ${tag()}`, sex: 'female', age: { years: 43 }, phone_e164: phone(), consents: consents(), ...o });
export const norm = (s: string) => s.normalize('NFC').toLowerCase().split(/\s+/u).filter(Boolean).join(' ');
export const T = 60_000;

/** Settings for both tenants (consent_text_version 'v1', min chars 3); idempotent. */
export async function seedSettings(): Promise<void> {
  for (const t of [TENANT_A, TENANT_B]) await seed('frontdesk.settings', { tenant_id: t, consent_text_version: CONSENT_VERSION, patient_search_min_chars: 3 });
}
/** A committed patient (+ one consent row) via superuser; returns the row. */
export async function seedPatient(side: 'a' | 'b', o: Record<string, unknown> = {}, c: Record<string, unknown> = {}): Promise<any> {
  const T_ = side === 'a' ? TENANT_A : TENANT_B;
  const name = String(o.full_name ?? `Fdt Seed ${tag()}`);
  const row = { id: uid(), tenant_id: T_, patient_code: `MP${digits(8)}`, full_name: name, name_search: norm(name), sex: 'female', birth_on: '1983-11-10',
    is_birth_on_estimated: false, phone_e164: phone(), source: 'front_desk', registered_centre_id: CENTRE[side], last_visit_at: '2026-11-01T04:00:00Z', ...o };
  await seed('frontdesk.patients', row);
  await seed('frontdesk.patient_consents', { id: uid(), tenant_id: T_, patient_id: row.id, processing: true, sms: false, whatsapp: false, email: false,
    share_with_referrer: false, consent_text_version: CONSENT_VERSION, source: 'front_desk', captured_at: '2026-11-01T04:00:00Z', ...c });
  return row;
}
export async function seedOrder(side: 'a' | 'b', patientId: string, o: Record<string, unknown> = {}): Promise<any> {
  const T_ = side === 'a' ? TENANT_A : TENANT_B;
  const row = { id: uid(), tenant_id: T_, branch_id: BRANCH[side], centre_id: CENTRE[side], patient_id: patientId, registration_no: `R${digits(6)}`,
    status: 'registered', visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk',
    is_first_order_of_patient: true, catalog_revision: 1, registered_at: '2026-11-07T00:00:00Z', ...o };
  await seed('frontdesk.orders', row);
  return row;
}
export const patientRow = async (id: string) => (await ownerRows('frontdesk.patients', 'id = $1', [id]))[0];
export const consentRows = async (patientId: string) => ownerRows('frontdesk.patient_consents', 'patient_id = $1 ORDER BY captured_at, created_at, id', [patientId]);
export const accessRows = async (action: string, requestId: string) =>
  ownerRows('audit.access_log', 'action = $1 AND request_id = $2', [action, requestId]);
export const countPatients = async (tenant: string) => Number((await superTx(async (tx) => (await tx.query('SELECT count(*)::int AS n FROM frontdesk.patients WHERE tenant_id = $1', [tenant])).rows[0].n)));
export const fileText = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
