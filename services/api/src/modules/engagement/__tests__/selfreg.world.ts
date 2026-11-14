// C16.T-L4 test world (tester-owned): self-registration E16/E17 + task engagement.create_self_patient on the shared FakeDb interpreter (fakeSql.ts; single-table statements only).
// Tables (05-SCHEMA): settings (app_enabled, app_consent_text[_version], minor_age_years), accounts, patients (FK target), link_consents (A; shape ck), self_registrations (E; created__ck, queued_fields__ck),
//   account_patient_links (linkDefs of link.world + the partial unique indexes ..._patient_id__p_uq / ..._account_self__p_uq emulated here as pg 23505).
// RLS emulation for the PATIENT actor (API side): a patient sees only its own account and its own self_registrations / links, may insert link_consents + self_registrations only for its own account and NEVER an
//   account_patient_links row with method 'self_registered' (that row is written by the system task). The SYSTEM actor (worker task) sees the tenant.
// FrontdeskPort = the shared fake packages/fakes/src/FrontdeskPort.fake.ts (CR-C16-007: createSelfRegisteredPatient: always a NEW patient, duplicateSuspected when a patient with the same phone exists, idempotent per key).
// app.enqueue_job calls are recorded in `jobs`. `inTx` models the core/queue transaction: tables + jobs roll back when the handler/task throws (unless it called ctx.commitOnError()).
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { createFakeFrontdeskPort } from '../../../../../../packages/fakes/src/FrontdeskPort.fake';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { FakeDb, type Row, type TableDef } from './fakeSql.js';
import { HMAC1 as LINK_HMAC1, linkDefs } from './link.report.world.js';

export const TA: string = TENANTS.A;
export const TB: string = TENANTS.B;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const ACC1 = ID(0xa1), ACC2 = ID(0xa2), MEM1 = ID(0xe1), MEM2 = ID(0xe2), SYSTEM = ID(0x5a);
export const PHONE1 = '+9779800000001', PHONE2 = '+9779800000002';
export const HMAC1 = LINK_HMAC1, HMAC2 = Buffer.alloc(32, 2);
export const T0 = '2026-11-05T04:15:00.000Z'; // ctx.now(); Nepal local time is 2026-11-05 10:00 (same calendar day as UTC)
export const VERSION = 'v2026-1'; // settings.app_consent_text_version
export const NAME = 'Synthetic Selfreg Sample'; // full_name used by the tests (scanned for in logs / audit / job payloads)
export const PAT_EXISTING = ID(0x11), PAT_OTHER_LINKED = ID(0x12);
export const ms = (v: unknown) => (v == null ? null : new Date(v as string).getTime());

const T = (columns: string[], more: Partial<TableDef> = {}): TableDef => ({ columns, ...more });
const has = (v: unknown) => v !== null && v !== undefined;
export const defs = (): Record<string, TableDef> => ({
  ...linkDefs(),
  settings: T(['id', 'tenant_id', 'app_enabled', 'app_consent_text', 'app_consent_text_version', 'minor_age_years', 'max_profiles_per_account', 'version'], { unique: [['id']] }),
  link_consents: T(['id', 'tenant_id', 'patient_id', 'account_id', 'source', 'relationship', 'consented_by', 'consent_text_version', 'identity_check_method', 'recorded_by_membership_id', 'recorded_at', 'created_at', 'created_by'], {
    notNull: ['id', 'tenant_id', 'source', 'relationship', 'consented_by', 'consent_text_version', 'created_by'], unique: [['id'], ['tenant_id', 'id']],
    fk: [{ cols: ['tenant_id', 'account_id'], ref: 'accounts', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'patient_id'], ref: 'patients', refCols: ['tenant_id', 'id'] }],
    check: (r) => (!['desk', 'app'].includes(r['source']) ? 'link_consents__source__ck'
      : !['self', 'child', 'parent', 'spouse', 'sibling', 'other'].includes(r['relationship']) ? 'link_consents__relationship__ck'
      : !['patient', 'guardian'].includes(r['consented_by']) ? 'link_consents__by__ck'
      : !(typeof r['consent_text_version'] === 'string' && r['consent_text_version'].length >= 1 && r['consent_text_version'].length <= 40) ? 'link_consents__version__ck'
      : r['source'] === 'app' && !has(r['account_id']) ? 'link_consents__shape__ck'
      : r['source'] === 'desk' && !(has(r['patient_id']) && has(r['identity_check_method']) && has(r['recorded_by_membership_id'])) ? 'link_consents__shape__ck' : undefined),
  }),
  self_registrations: T(['id', 'tenant_id', 'account_id', 'relationship', 'full_name', 'sex', 'birth_on', 'age_years', 'sms_consent', 'whatsapp_consent', 'consent_id', 'status', 'patient_id', 'link_id', 'failure_code',
    'created_at', 'created_by', 'updated_at', 'expires_at'], {
    notNull: ['id', 'tenant_id', 'account_id', 'relationship', 'sms_consent', 'whatsapp_consent', 'consent_id', 'status', 'created_by', 'expires_at'],
    defaults: { status: 'queued', patient_id: null, link_id: null, failure_code: null, birth_on: null, age_years: null },
    unique: [['id'], ['tenant_id', 'id']],
    fk: [{ cols: ['tenant_id', 'account_id'], ref: 'accounts', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'consent_id'], ref: 'link_consents', refCols: ['tenant_id', 'id'] },
      { cols: ['tenant_id', 'patient_id'], ref: 'patients', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'link_id'], ref: 'account_patient_links', refCols: ['tenant_id', 'id'] }],
    check: (r) => (!['self', 'child'].includes(r['relationship']) ? 'self_registrations__relationship__ck'
      : !['queued', 'created', 'failed'].includes(r['status']) ? 'self_registrations__status__ck'
      : (r['status'] === 'created') !== (has(r['patient_id']) && has(r['link_id'])) ? 'self_registrations__created__ck'
      : has(r['sex']) && !['male', 'female', 'other', 'unknown'].includes(r['sex']) ? 'self_registrations__sex__ck'
      : has(r['age_years']) && !(r['age_years'] >= 0 && r['age_years'] <= 150) ? 'self_registrations__age__ck'
      : has(r['full_name']) && !(r['full_name'].length >= 1 && r['full_name'].length <= 200) ? 'self_registrations__name__ck'
      : r['status'] === 'queued' && !(has(r['full_name']) && has(r['sex']) && (has(r['birth_on']) || has(r['age_years']))) ? 'self_registrations__queued_fields__ck' : undefined),
  }),
});

const account = (id: string, mem: string, phone: string, hmac: Buffer): Row => ({ id, tenant_id: TA, membership_id: mem, user_id: ID(0xf0), phone_e164: phone, phone_hmac: hmac, status: 'active', last_login_at: T0, version: 1 });
const deep = (v: any): any => (v instanceof Uint8Array ? Buffer.from(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);

export function makeWorld(o: { settings?: Row; seed?: (w: { tables: Record<string, Row[]> }) => void } = {}) {
  const clock = { iso: T0 };
  const tables: Record<string, Row[]> = {
    patients: [{ id: PAT_EXISTING, tenant_id: TA }, { id: PAT_OTHER_LINKED, tenant_id: TA }],
    settings: [{ id: ID(0x5e), tenant_id: TA, app_enabled: true, app_consent_text: 'Synthetic consent text', app_consent_text_version: VERSION, minor_age_years: 18, max_profiles_per_account: 8, version: 1, ...o.settings }],
    accounts: [account(ACC1, MEM1, PHONE1, HMAC1), account(ACC2, MEM2, PHONE2, HMAC2)],
    link_consents: [], self_registrations: [], account_patient_links: [],
  };
  o.seed?.({ tables });
  const db = new FakeDb(tables, defs(), clock);
  const events: string[] = [];
  const jobs: Array<{ identifier: unknown; payload: any; jobKey: unknown; values: unknown[] }> = [];
  const logs: unknown[] = [];
  const audit = { access: [] as any[], event: [] as any[] };

  // ---- FrontdeskPort (shared fake, CR-C16-007) + a seeded EXISTING patient with phone P1 so that a self-registration by A1 is a "duplicate suspected" ----
  const fake = createFakeFrontdeskPort({ seed: 1 });
  const frontdesk = {
    fake, calls: [] as Array<{ actor: string; tenantId: string; input: any }>,
    created: [] as Array<{ patientId: string; input: any }>, // C4 records actually created (a replayed idempotency key creates nothing)
    failWith: undefined as undefined | (() => unknown), // non-LimsError / arbitrary failures (a LimsError code can also use fake.failNext)
    seedExistingWithPhone(phone = PHONE1) {
      fake.__seed({ patients: [{ id: PAT_EXISTING, tenantId: TA, patientCode: 'P-EXIST', fullName: 'Synthetic Existing Person', sex: 'female', birthOn: '1990-01-01', phoneE164: phone,
        consents: { sms: true, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'v1' }, status: 'active' }] as never });
    },
    port: {
      async createSelfRegisteredPatient(ctx: any, input: any) {
        frontdesk.calls.push({ actor: ctx?.actor?.type, tenantId: ctx?.tenantId, input: deep(input) }); events.push('port');
        if (frontdesk.failWith) throw frontdesk.failWith();
        const r = await (fake as any).createSelfRegisteredPatient(ctx, input);
        if (!r.replayed) frontdesk.created.push({ patientId: r.patientId, input: deep(input) });
        if (!tables['patients']!.some((p) => p['id'] === r.patientId)) tables['patients']!.push({ id: r.patientId, tenant_id: ctx.tenantId });
        return r;
      },
      async getPatientDemographics() { throw new Error('FrontdeskPort.getPatientDemographics must not be used by self-registration (the new record is described by the registration row)'); },
    },
  };

  const grants = new Set<string>(['engagement.self.manage', 'engagement.self.read']);
  const identity = {
    asserted: [] as Array<{ permission: string; at: number }>, deny: new Set<string>(),
    async assertRole(_ctx: unknown, r: { permission: string }) {
      identity.asserted.push({ permission: r?.permission, at: db.calls.length });
      if (identity.deny.has(r?.permission) || !grants.has(r?.permission)) throw new LimsError('auth.forbidden');
    },
  };

  const ctxFor = makeCtxFor();
  const commit = { requested: false };
  /** Common ctx. `who: 'patient'` = API request (RLS emulation for `account`), `'system'` = worker job, `'user'` = a staff actor (wrong-actor probe). */
  const build = (who: 'patient' | 'system' | 'user', account_: string, tenant: string, over: Record<string, unknown>) => {
    const s = db.session(tenant, { all: true, centres: [] }, who === 'system' ? SYSTEM : MEM1);
    const mine = () => tables['accounts']!.find((a) => a['id'] === account_)!;
    const tx = {
      async query(text: string, values: unknown[] = []) {
        events.push(`stmt:${text}`);
        if (/app\.enqueue_job/i.test(text)) {
          await s.tx.query(text, values);
          const job = { identifier: values[0], payload: typeof values[1] === 'string' ? JSON.parse(values[1] as string) : values[1], jobKey: values[2], values };
          if (job.jobKey != null && jobs.some((j) => j.identifier === job.identifier && j.jobKey === job.jobKey)) return { rows: [{ enqueue_job: 1 }], rowCount: 1 }; // job_key dedupe
          jobs.push(job); return { rows: [{ enqueue_job: 1 }], rowCount: 1 };
        }
        const verb = /^\s*(select|insert|update|delete)\b/i.exec(text)?.[1]?.toLowerCase();
        const tbl = (/\b(?:from|into|update)\s+(?:engagement\.)?(\w+)/i.exec(text) ?? [])[1];
        const res: any = await s.tx.query(text, values);
        if (who !== 'system' && verb === 'select' && !/^\s*select\s+count\(\*\)/i.test(text)) { // patient RLS: own account, own registrations, own links
          if (tbl === 'accounts') res.rows = res.rows.filter((r: Row) => r['id'] === account_);
          if (tbl === 'self_registrations' || tbl === 'account_patient_links' || tbl === 'link_consents') res.rows = res.rows.filter((r: Row) => r['account_id'] === account_);
          res.rowCount = res.rows.length;
        }
        if (verb === 'insert' && res.rowCount > 0 && ['link_consents', 'self_registrations', 'account_patient_links'].includes(tbl!)) {
          const rows = tables[tbl!]!, mineRow = rows[rows.length - 1]!;
          const undo = (constraint: string, code = '23505') => { rows.pop(); throw Object.assign(new Error(`violates ${constraint}`), { code, constraint }); };
          if (who === 'patient' && (mineRow['account_id'] !== account_ || (tbl === 'account_patient_links' && mineRow['method'] !== 'report_link'))) undo(`new row violates row-level security policy (${tbl})`, '42501');
          if (tbl === 'account_patient_links' && ['active', 'suspended'].includes(mineRow['status'])) {
            const live = (r: Row) => r !== mineRow && r['tenant_id'] === mineRow['tenant_id'] && r['account_id'] === mineRow['account_id'] && ['active', 'suspended'].includes(r['status']);
            if (rows.some((r) => live(r) && r['patient_id'] === mineRow['patient_id'])) undo('account_patient_links__tenant_id_account_id_patient_id__p_uq');
            if (mineRow['relationship'] === 'self' && rows.some((r) => live(r) && r['relationship'] === 'self')) undo('account_patient_links__tenant_id_account_self__p_uq');
          }
        }
        if (who !== 'system' && verb === 'update' && (tbl === 'self_registrations' || tbl === 'link_consents')) throw Object.assign(new Error('permission denied for table (patients never update self_registrations; the system task does)'), { code: '42501' });
        return res;
      },
    };
    const base: any = ctxFor(`${tenant === TB ? 'B' : 'A'}:${who}`, { tx: tx as never, now: () => clock.iso, ports: { IdentityPort: identity, FrontdeskPort: frontdesk.port } as never });
    const log = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), debug: (...a: unknown[]) => logs.push(a), child() { return log; } };
    const ctx: any = { ...base, actor: { type: who, id: who === 'system' ? SYSTEM : mine()['membership_id'] }, audit: { access: async (e: unknown) => { audit.access.push(e); events.push('audit'); }, event: async (e: unknown) => { audit.event.push(e); } },
      clientIp: '203.0.113.9', log, metrics: { inc() {}, set() {}, observe() {} }, commitOnError() { commit.requested = true; }, rateLimit: { async consume() {} }, ...over };
    return ctx;
  };
  /** API request context of a patient session (account default A1). */
  const session = (account_ = ACC1, over: Record<string, unknown> = {}, who: 'patient' | 'user' = 'patient', tenant = TA) => build(who, account_, tenant, { operationId: 'createSelfRegistration', ...over });
  /** Worker job context (system actor) for the create_self_patient task. */
  const jobCtx = (over: Record<string, unknown> = {}) => build('system', ACC1, TA, { jobId: '1', attempt: 1, maxAttempts: 10, ...over });

  /** One transaction like the core pipeline / queue worker: DB state + jobs roll back when `f` throws, unless commitOnError() was requested. The FrontdeskPort fake is NOT rolled back by this
   *  (the call happened; the fake's per-key idempotency is the real C4 contract). */
  async function inTx<T>(f: () => Promise<T>): Promise<T> {
    const snap = deep({ tables, jobs }); const auditN = [audit.access.length, audit.event.length]; commit.requested = false;
    try { return await f(); } catch (e) {
      if (!commit.requested) {
        for (const k of Object.keys(tables)) tables[k]!.splice(0, tables[k]!.length, ...snap.tables[k]);
        jobs.splice(0, jobs.length, ...snap.jobs); audit.access.length = auditN[0]!; audit.event.length = auditN[1]!;
      }
      throw e;
    }
  }

  return {
    db, tables, clock, jobs, logs, audit, events, frontdesk, identity, grants, session, jobCtx, inTx, commit,
    get stmts() { return db.calls; },
    writes: () => db.calls.filter((c) => /^\s*(insert|update|delete)\b|enqueue_job/i.test(c.text)),
    regs: (account_ = ACC1) => tables['self_registrations']!.filter((r) => r['account_id'] === account_),
    consents: (account_ = ACC1) => tables['link_consents']!.filter((r) => r['account_id'] === account_),
    links: (account_ = ACC1) => tables['account_patient_links']!.filter((l) => l['account_id'] === account_),
    setSetting: (k: string, v: unknown) => { tables['settings']![0]![k] = v; },
    seedLink: (o_: Row = {}): Row => {
      const l: Row = { id: ID(0xc1), tenant_id: TA, account_id: ACC1, patient_id: PAT_OTHER_LINKED, relationship: 'self', method: 'report_link', link_code_id: null, consent_id: null, display_name: 'Synthetic Linked', sex_snapshot: null,
        status: 'active', suspend_reason: null, suspended_at: null, visible_from: '2026-10-01T00:00:00.000Z', record_phone_hmac_at_link: HMAC1, revoked_by_kind: null, revoked_reason_code: null, revoked_at: null, version: 1, is_active: true,
        created_at: '2026-10-02T00:00:00.000Z', created_by: MEM1, updated_at: '2026-10-02T00:00:00.000Z', updated_by: MEM1, ...o_ };
      tables['account_patient_links']!.push(l); return l;
    },
    /** A queued registration row exactly as the E16 handler must leave it (for task tests that do not go through the handler). */
    seedQueuedReg: (o_: Row = {}): Row => {
      const consent: Row = { id: ID(0xc0 + tables['link_consents']!.length), tenant_id: TA, patient_id: null, account_id: ACC1, source: 'app', relationship: 'self', consented_by: 'patient', consent_text_version: VERSION,
        identity_check_method: null, recorded_by_membership_id: null, recorded_at: T0, created_at: T0, created_by: MEM1 };
      tables['link_consents']!.push(consent);
      const r: Row = { id: ID(0x5100 + tables['self_registrations']!.length), tenant_id: TA, account_id: ACC1, relationship: 'self', full_name: NAME, sex: 'female', birth_on: '1990-03-01', age_years: null, sms_consent: true, whatsapp_consent: false,
        consent_id: consent['id'], status: 'queued', patient_id: null, link_id: null, failure_code: null, created_at: T0, created_by: MEM1, updated_at: T0, expires_at: '2026-12-05T04:15:00.000Z', ...o_ };
      tables['self_registrations']!.push(r); return r;
    },
  };
}
export type World = ReturnType<typeof makeWorld>;
