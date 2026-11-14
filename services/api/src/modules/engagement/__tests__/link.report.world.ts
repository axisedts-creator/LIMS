// C16.T-L3 test world (tester-owned): accounts + account_patient_links on the shared FakeDb interpreter (fakeSql.ts) + fakes for ReportingPort.redeemPortalLinkForApp
// (CR-C16-008 / C6 02-TRD), IdentityPort.assertRole, FrontdeskPort (must stay unused in the request) and ctx.audit.access. Grammar limit as fakeSql.ts: single-table statements only.
// Models (05-SCHEMA): PAT_ACC (patient selects see only their own account / own links), PAT_LINK_INS (patient insert: own account, method 'report_link' only — a link_code
//   insert needs a redeemed code, never present here), the partial unique indexes account_patient_links__..._patient_id__p_uq and ..._account_self__p_uq (pg 23505),
//   the patient column guard of §4 / probe P-L9 (a direct patient UPDATE of status->active, visible_from, method, ... raises `immutable_row`), and the DEFINER
//   app.engagement_apply_report_link(uuid, timestamptz) of §6.1 (emulated on the tables: the ONLY way a patient session may widen visible_from / reactivate).
// app.enqueue_job calls are recorded in `jobs`; `events` is the ordered log of statements and port calls (to prove "no write before the C6 call").
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { FakeDb, type Row, type TableDef } from './fakeSql.js';

export const TA: string = TENANTS.A;
export const TB: string = TENANTS.B;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const ORIGIN = 'https://portal.lims.test';
export const PERM = 'engagement.link.redeem';
export const ACC1 = ID(0xa1), ACC2 = ID(0xa2), ACC3 = ID(0xa3), MEM1 = ID(0xe1), MEM2 = ID(0xe2), MEM3 = ID(0xe3), STAFF = ID(0x5f);
export const PAT_X = ID(0x11), PAT_Y = ID(0x12), PAT_Z = ID(0x13), PAT_B = ID(0x1b);
export const PHONE1 = '+9779800000001', PHONE2 = '+9779800000002', PHONE3 = '+9779800000003';
export const HMAC1 = Buffer.alloc(32, 1), HMAC2 = Buffer.alloc(32, 2), HMAC3 = Buffer.alloc(32, 3);
export const T0 = '2026-11-05T04:15:00.000Z'; // ctx.now()
export const REL_T = '2026-10-20T06:30:00.123Z'; // releasedAt of the redeemed report (ms precision matters for P-L6)
export const REL_OLD = '2026-10-01T00:00:00.000Z', REL_NEW = '2026-11-01T00:00:00.000Z';
export const TOK = { X: 'Xk3Jq9ZbLw7Rt2VnYs5HdA', X_OLD: 'Qm8Wc4NfTy1Uj6PgRb0EsK', X_NEW: 'Hd5Vp2LsAe9Ox7MzCn3TwB', Z: 'Zz1Aa2Bb3Cc4Dd5Ee6Ff7G', EXPIRED: 'Ex9Pi4Re7Dl1Nk3Ab5Cd0Q', REVOKED: 'Rv2Ok5Ed8Lk3Nn6Ab9Cd1W', UNKNOWN: 'Un1Kn2Ow3Nt4Ok5En6Ab7C', B: 'Bb1Tn2An3Tb4Pp5Qq6Rr7S' } as const;
export const TOK64 = 'T'.repeat(63) + '_'; // 64 chars of [A-Za-z0-9_-]
export const url = (token: string) => `${ORIGIN}/r/${token}`;
export const ms = (v: unknown) => (v == null ? null : new Date(v as string).getTime());

const T = (columns: string[], more: Partial<TableDef> = {}): TableDef => ({ columns, ...more });
const RELS = ['self', 'child', 'parent', 'spouse', 'sibling', 'other'];
export const linkDefs = (): Record<string, TableDef> => ({
  patients: T(['id', 'tenant_id'], { unique: [['id']] }),
  settings: T(['id', 'tenant_id', 'app_enabled', 'max_profiles_per_account', 'max_accounts_per_patient', 'version'], { unique: [['id']] }),
  accounts: T(['id', 'tenant_id', 'membership_id', 'user_id', 'phone_e164', 'phone_hmac', 'status', 'last_login_at', 'version'], { unique: [['id']] }),
  account_patient_links: T(['id', 'tenant_id', 'account_id', 'patient_id', 'relationship', 'method', 'link_code_id', 'consent_id', 'display_name', 'sex_snapshot', 'status', 'suspend_reason', 'suspended_at', 'visible_from',
    'record_phone_hmac_at_link', 'revoked_by_kind', 'revoked_reason_code', 'revoked_at', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
    notNull: ['id', 'tenant_id', 'account_id', 'patient_id', 'relationship', 'method', 'display_name', 'status', 'version', 'created_by', 'updated_by'],
    defaults: { status: 'active', version: 1, is_active: true, link_code_id: null, consent_id: null, sex_snapshot: null, suspend_reason: null, suspended_at: null, visible_from: null, record_phone_hmac_at_link: null, revoked_by_kind: null, revoked_reason_code: null, revoked_at: null },
    unique: [['id'], ['tenant_id', 'id']],
    fk: [{ cols: ['tenant_id', 'account_id'], ref: 'accounts', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'patient_id'], ref: 'patients', refCols: ['tenant_id', 'id'] }],
    check: (r) => (!RELS.includes(r['relationship']) ? 'account_patient_links__relationship__ck'
      : !['link_code', 'report_link', 'self_registered'].includes(r['method']) ? 'account_patient_links__method__ck'
      : r['method'] === 'link_code' && !r['link_code_id'] ? 'account_patient_links__method_code__ck'
      : !['active', 'suspended', 'revoked'].includes(r['status']) ? 'account_patient_links__status__ck'
      : (r['status'] === 'suspended') !== Boolean(r['suspend_reason'] && r['suspended_at']) ? 'account_patient_links__suspend__ck'
      : (r['status'] === 'revoked') !== Boolean(r['revoked_by_kind'] && r['revoked_at']) ? 'account_patient_links__revoke__ck'
      : !(typeof r['display_name'] === 'string' && r['display_name'].length >= 1 && r['display_name'].length <= 200) ? 'account_patient_links__name__ck'
      : r['record_phone_hmac_at_link'] != null && Buffer.from(r['record_phone_hmac_at_link']).length !== 32 ? 'account_patient_links__phone_hmac__ck' : undefined),
  }),
});

export const link = (o: Row = {}): Row => ({ id: ID(0xc1), tenant_id: TA, account_id: ACC1, patient_id: PAT_X, relationship: 'other', method: 'report_link', link_code_id: null, consent_id: null, display_name: 'Synthetic Patient X', sex_snapshot: null,
  status: 'active', suspend_reason: null, suspended_at: null, visible_from: REL_OLD, record_phone_hmac_at_link: HMAC1, revoked_by_kind: null, revoked_reason_code: null, revoked_at: null, version: 1, is_active: true,
  created_at: '2026-10-02T00:00:00.000Z', created_by: MEM1, updated_at: '2026-10-02T00:00:00.000Z', updated_by: MEM1, ...o });
const account = (id: string, mem: string, phone: string, hmac: Buffer, tenant = TA): Row => ({ id, tenant_id: tenant, membership_id: mem, user_id: ID(0xf0), phone_e164: phone, phone_hmac: hmac, status: 'active', last_login_at: T0, version: 1 });

/** C6 token book (what ReportingPort.redeemPortalLinkForApp would find): valid only for the phone the link was sent to. */
export interface TokenRow { patientId: string; reportId: string; versionNo: number; releasedAt: string; phone: string; state?: 'valid' | 'expired' | 'revoked' }
const defaultTokens = (): Record<string, TokenRow> => ({
  [TOK.X]: { patientId: PAT_X, reportId: ID(0xd1), versionNo: 1, releasedAt: REL_T, phone: PHONE1 },
  [TOK.X_OLD]: { patientId: PAT_X, reportId: ID(0xd2), versionNo: 1, releasedAt: REL_OLD, phone: PHONE1 },
  [TOK.X_NEW]: { patientId: PAT_X, reportId: ID(0xd3), versionNo: 2, releasedAt: REL_NEW, phone: PHONE1 },
  [TOK.Z]: { patientId: PAT_Z, reportId: ID(0xd4), versionNo: 1, releasedAt: REL_T, phone: PHONE1 },
  [TOK64]: { patientId: PAT_X, reportId: ID(0xd5), versionNo: 1, releasedAt: REL_T, phone: PHONE1 },
  [TOK.EXPIRED]: { patientId: PAT_X, reportId: ID(0xd6), versionNo: 1, releasedAt: REL_T, phone: PHONE1, state: 'expired' },
  [TOK.REVOKED]: { patientId: PAT_X, reportId: ID(0xd7), versionNo: 1, releasedAt: REL_T, phone: PHONE1, state: 'revoked' },
});

export function makeWorld(o: { tenant?: string; seed?: (w: { tables: Record<string, Row[]> }) => void } = {}) {
  const clock = { iso: T0 };
  const tables: Record<string, Row[]> = {
    patients: [PAT_X, PAT_Y, PAT_Z].map((id) => ({ id, tenant_id: TA })).concat([{ id: PAT_B, tenant_id: TB }]),
    settings: [{ id: ID(0x5e), tenant_id: TA, app_enabled: true, max_profiles_per_account: 8, max_accounts_per_patient: 3, version: 1 }],
    accounts: [account(ACC1, MEM1, PHONE1, HMAC1), account(ACC2, MEM2, PHONE2, HMAC2), account(ACC3, MEM3, PHONE3, HMAC3)],
    account_patient_links: [],
  };
  o.seed?.({ tables });
  const db = new FakeDb(tables, linkDefs(), clock);
  const events: string[] = [];
  const jobs: Array<{ identifier: unknown; payload: any; jobKey: unknown; values: unknown[] }> = [];
  const applied: Array<{ patientId: unknown; releasedAt: unknown; accountId: string; result: Row[] }> = [];
  const tokens = defaultTokens();

  const reporting = {
    calls: [] as Array<{ ctx: any; input: any }>,
    failWith: undefined as undefined | (() => unknown),
    port: {
      async redeemPortalLinkForApp(ctx: any, input: { linkToken: string; phoneE164: string }) {
        reporting.calls.push({ ctx, input }); events.push('port');
        if (reporting.failWith) throw reporting.failWith();
        const t = tokens[input?.linkToken];
        if (!t || (t.state ?? 'valid') !== 'valid' || t.phone !== input.phoneE164) throw new LimsError('reporting.link_invalid'); // identical for every cause (REQ-SEC-094)
        return { patientId: t.patientId, reportId: t.reportId, versionNo: t.versionNo, releasedAt: t.releasedAt };
      },
    },
  };
  const frontdesk = { calls: [] as unknown[], port: { async getPatientDemographics(...a: unknown[]) { frontdesk.calls.push(a); throw new Error('FrontdeskPort must not be called inside E15 (backfill task does it as system)'); } } };
  const grants = new Set<string>([PERM]);
  const identity = {
    asserted: [] as Array<{ permission: string; at: number }>, deny: new Set<string>(),
    async assertRole(_ctx: unknown, r: { permission: string }) {
      identity.asserted.push({ permission: r?.permission, at: db.calls.length });
      if (identity.deny.has(r?.permission) || !grants.has(r?.permission)) throw new LimsError('auth.forbidden');
    },
  };
  const audit = { access: [] as any[], event: [] as any[] };
  const logs: unknown[] = [];
  const guardCols = ['visible_from', 'method', 'link_code_id', 'consent_id', 'record_phone_hmac_at_link', 'suspend_reason', 'suspended_at', 'patient_id', 'account_id', 'sex_snapshot', 'display_name', 'tenant_id'];

  const ctxFor = makeCtxFor();
  /** Patient session of `account` (default ACC1). `who: 'staff'` gives a user actor (for the wrong-actor probe). */
  const session = (account = ACC1, over: Record<string, unknown> = {}, who: 'patient' | 'user' = 'patient', tenant = o.tenant ?? TA) => {
    const s = db.session(tenant, { all: true, centres: [] }, MEM1);
    const mine = () => tables['accounts']!.find((a) => a['id'] === account)!;
    const tx = {
      async query(text: string, values: unknown[] = []) {
        events.push(`stmt:${text}`);
        if (/app\.enqueue_job/i.test(text)) {
          await s.tx.query(text, values);
          jobs.push({ identifier: values[0], payload: typeof values[1] === 'string' ? JSON.parse(values[1] as string) : values[1], jobKey: values[2], values });
          return { rows: [], rowCount: 1 };
        }
        if (/engagement_apply_report_link/i.test(text)) { // DEFINER (owner policies): sees every link of the caller's ACCOUNT, bypasses the §4 column guard
          await s.tx.query(text, values);
          const [pid, rel] = values as [string, string];
          const l = tables['account_patient_links']!.find((x) => x['tenant_id'] === tenant && x['account_id'] === account && x['patient_id'] === pid && ['active', 'suspended'].includes(x['status']));
          const result: Row[] = [];
          if (l && rel != null) {
            const prior = l['status'];
            if (prior === 'active') { if (l['visible_from'] != null && ms(rel)! < ms(l['visible_from'])!) l['visible_from'] = rel; }
            else { Object.assign(l, { status: 'active', suspend_reason: null, suspended_at: null, visible_from: rel, record_phone_hmac_at_link: mine()['phone_hmac'] }); }
            l['version'] += 1; l['updated_at'] = clock.iso;
            result.push({ link_id: l['id'], prior_status: prior });
          }
          applied.push({ patientId: pid, releasedAt: rel, accountId: account, result });
          return { rows: result, rowCount: result.length };
        }
        const verb = /^\s*(select|insert|update|delete)\b/i.exec(text)?.[1]?.toLowerCase();
        const tbl = (/\b(?:from|into|update)\s+(?:engagement\.)?(\w+)/i.exec(text) ?? [])[1];
        if (who === 'patient' && verb === 'update' && tbl === 'account_patient_links') { // §4 column guard (P-L9)
          const set = /\bset\s+(.+?)(?:\s+where\b|\s+returning\b|;?\s*$)/is.exec(text)?.[1] ?? '';
          const cols = set.split(',').map((x) => x.split('=')[0]!.trim().replace(/^\w+\./, ''));
          const revoking = cols.includes('status') && (/'revoked'/i.test(set) || values.includes('revoked'));
          if (cols.some((c) => guardCols.includes(c)) || (cols.includes('status') && !revoking)) throw Object.assign(new Error('immutable_row'), { code: 'P0001', hint: 'immutable_row' });
        }
        const res: any = await s.tx.query(text, values);
        if (who === 'patient' && verb === 'select' && !/^\s*select\s+count\(\*\)/i.test(text)) { // (count(*) statements are only used with the account id in WHERE: the limit check)
          if (tbl === 'accounts') res.rows = res.rows.filter((r: Row) => r['id'] === account);
          if (tbl === 'account_patient_links') res.rows = res.rows.filter((r: Row) => r['account_id'] === account);
          res.rowCount = res.rows.length;
        }
        if (verb === 'insert' && tbl === 'account_patient_links' && res.rowCount > 0) {
          const rows = tables['account_patient_links']!, mineRow = rows[rows.length - 1]!;
          const undo = (constraint: string, code = '23505') => { rows.pop(); throw Object.assign(new Error(`violates ${constraint}`), { code, constraint }); };
          if (who === 'patient' && (mineRow['account_id'] !== account || mineRow['method'] !== 'report_link')) undo('new row violates row-level security policy PAT_LINK_INS', '42501');
          const live = (r: Row) => r !== mineRow && r['tenant_id'] === mineRow['tenant_id'] && r['account_id'] === mineRow['account_id'] && ['active', 'suspended'].includes(r['status']);
          if (['active', 'suspended'].includes(mineRow['status'])) {
            if (rows.some((r) => live(r) && r['patient_id'] === mineRow['patient_id'])) undo('account_patient_links__tenant_id_account_id_patient_id__p_uq');
            if (mineRow['relationship'] === 'self' && rows.some((r) => live(r) && r['relationship'] === 'self')) undo('account_patient_links__tenant_id_account_self__p_uq');
          }
        }
        return res;
      },
    };
    const acc = mine();
    const base: any = ctxFor(`${tenant === TB ? 'B' : 'A'}:${who}`, { tx: tx as never, now: () => clock.iso, ports: { IdentityPort: identity, ReportingPort: reporting.port, FrontdeskPort: frontdesk.port } as never });
    const log = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), debug: (...a: unknown[]) => logs.push(a), child() { return log; } };
    const ctx: any = { ...base, actor: { type: who, id: acc['membership_id'] }, audit: { access: async (e: unknown) => { audit.access.push(e); events.push('audit'); }, event: async (e: unknown) => { audit.event.push(e); } },
      operationId: 'redeemReportLink', clientIp: '203.0.113.9', log, metrics: { inc() {}, set() {}, observe() {} }, commitOnErrorCalls: 0, commitOnError() { ctx.commitOnErrorCalls++; },
      rateLimit: { async consume() {} }, ...over };
    return ctx;
  };
  return {
    db, tables, clock, reporting, frontdesk, identity, audit, jobs, applied, events, logs, tokens, grants, session,
    get stmts() { return db.calls; },
    writes: () => db.calls.filter((c) => /^\s*(insert|update|delete)\b|enqueue_job|engagement_apply_report_link/i.test(c.text)),
    links: (account = ACC1) => tables['account_patient_links']!.filter((l) => l['account_id'] === account),
    /** The visibility rule of app.engagement_patient_visible (05-SCHEMA §6): active AND (visible_from IS NULL OR at >= visible_from). */
    visible: (account: string, patientId: string, atIso: string) => tables['account_patient_links']!.some((l) => l['account_id'] === account && l['patient_id'] === patientId && l['status'] === 'active' && (l['visible_from'] == null || ms(atIso)! >= ms(l['visible_from'])!)),
  };
}
export type World = ReturnType<typeof makeWorld>;
