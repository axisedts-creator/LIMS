// C16.T-N1 test world (tester-owned): engagement.enquiries / enquiry_messages / notifications / accounts / account_patient_links / settings on the shared FakeDb (fakeSql.ts)
// for E48-E51 (patient) and N1-N4 (staff). Used by service/__tests__/enquiry.handlers.test.ts; self-test: enquiries.world.test.ts.
// FakeDb has no OR / row-value keyset / IN, so every SELECT on enquiries / enquiry_messages / notifications is answered by `selectGeneric` below, which rewrites the statement for the
// evaluator already used by T-P5 (notifications.world.ts: WHERE AND/OR/NOT, = <> != < <= > >=, IS [NOT] NULL, col = ANY($n), row-value compare, ::casts; ORDER BY; LIMIT) and adds
// IN (..), table alias, `count(*) [AS x]`, and FOR UPDATE [SKIP LOCKED] (row locks held until the request finishes). Anything it cannot parse throws `enquiries-world: unsupported ...`
// (loud, never a silent pass). pg_advisory_xact_lock(..) is modelled (serialises requests with the same arguments until the request ends); pg_try_advisory_* is refused.
// RLS modelled (05-SCHEMA §8): tenant on every statement; a patient actor (PAT_ACC) sees / updates only rows of ITS account, inserts only enquiries with account_id = own account
//   and patient_id NULL or the patient of an ACTIVE link of that account, inserts only enquiry_messages with author_kind 'patient' for its own account, and cannot insert notifications;
//   a staff actor is tenant-wide, inserts only author_kind 'staff' messages and no enquiries. enquiry_messages is append-only (no mutable column). DELETE is refused by FakeDb.
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { FakeDb, type Row, type TableDef } from './fakeSql.js';
import { ACC1, ACC2, ACC_B, ID, LINK1, LINK3, LINK_ACC2, LINK_B, NOTIFICATION_COLUMNS, PAT1, PAT2, PAT3, PAT_B, STAFF, TA, TB, schemaDefs as notificationDefs, selectNotifications } from './notifications.world.js';

export { ACC1, ACC2, ACC_B, ID, LINK1, LINK3, LINK_ACC2, LINK_B, NOTIFICATION_COLUMNS, PAT1, PAT2, PAT3, PAT_B, STAFF, TA, TB };
export const P = {
  SELF_READ: 'engagement.self.read', ENQ_CREATE: 'engagement.enquiry.create', ENQ_READ: 'engagement.enquiry.read', ENQ_RESPOND: 'engagement.enquiry.respond',
} as const;
export const EQ = (n: number) => ID(0xf00 + n); // enquiry ids
export const MS = (n: number) => ID(0xf80 + n); // message ids
export const STAFF_B = ID(0x5b);
export const MEMBERSHIP = { [ACC1]: ID(0xe1), [ACC2]: ID(0xe2), [ACC_B]: ID(0xeb) } as Record<string, string>;
export const NOW = '2026-11-05T04:15:00.000Z';

export const ENQUIRY_COLUMNS = ['id', 'tenant_id', 'account_id', 'patient_id', 'category_code', 'subject', 'status', 'last_message_at', 'closed_at', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'] as const;
export const MESSAGE_COLUMNS = ['id', 'tenant_id', 'enquiry_id', 'account_id', 'author_kind', 'author_id', 'body', 'created_at', 'created_by'] as const;

const T = (columns: readonly string[], more: Partial<TableDef> = {}): TableDef => ({ columns, ...more });
export const schemaDefs = (clock: { iso: string }): Record<string, TableDef> => ({
  ...notificationDefs(),
  settings: T(['id', 'tenant_id', 'enquiries_enabled', 'version']),
  enquiries: T(ENQUIRY_COLUMNS, {
    notNull: ['id', 'tenant_id', 'account_id', 'category_code', 'subject', 'status', 'last_message_at', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    defaults: { patient_id: null, status: 'open', closed_at: null, version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso },
    unique: [['id'], ['tenant_id', 'id']],
    mutable: ['status', 'last_message_at', 'closed_at', 'version', 'updated_at', 'updated_by'], // everything else is fixed after creation
    check: (r) => !['open', 'answered', 'closed'].includes(r['status']) ? 'enquiries__status__ck'
      : (r['status'] === 'closed') !== (r['closed_at'] !== null && r['closed_at'] !== undefined) ? 'enquiries__closed__ck'
      : [...String(r['subject'])].length < 1 || [...String(r['subject'])].length > 120 ? 'enquiries__subject__ck'
      : [...String(r['category_code'])].length < 1 || [...String(r['category_code'])].length > 64 ? 'enquiries__category__ck' : undefined,
  }),
  enquiry_messages: T(MESSAGE_COLUMNS, {
    notNull: ['id', 'tenant_id', 'enquiry_id', 'account_id', 'author_kind', 'author_id', 'body', 'created_at', 'created_by'],
    defaults: { created_at: clock.iso },
    unique: [['id'], ['tenant_id', 'id']],
    mutable: [], // append-only (05-SCHEMA §8: S I only)
    check: (r) => !['patient', 'staff'].includes(r['author_kind']) ? 'enquiry_messages__author__ck'
      : [...String(r['body'])].length < 1 || [...String(r['body'])].length > 2000 ? 'enquiry_messages__body__ck' : undefined,
  }),
});

export const enquiry = (o: Row = {}): Row => ({ id: EQ(1), tenant_id: TA, account_id: ACC1, patient_id: PAT1, category_code: 'report', subject: 'Synthetic subject one', status: 'open', last_message_at: '2026-11-04T10:00:00.000Z',
  closed_at: null, version: 3, is_active: true, created_at: '2026-11-04T10:00:00.000Z', created_by: MEMBERSHIP[ACC1], updated_at: '2026-11-04T10:00:00.000Z', updated_by: MEMBERSHIP[ACC1], ...o });
export const message = (o: Row = {}): Row => ({ id: MS(1), tenant_id: TA, enquiry_id: EQ(1), account_id: ACC1, author_kind: 'patient', author_id: ACC1, body: 'Synthetic patient message one', created_at: '2026-11-04T10:00:00.000Z', created_by: MEMBERSHIP[ACC1], ...o });

/** E1 open (v3, own, profile PAT1) | E2 answered (v4, own, no profile) | E3 closed (v5, own) | E4 open (ACC2, same tenant) | E5 open (tenant B). */
export const seedEnquiries = (): Row[] => [
  enquiry({ id: EQ(1) }),
  enquiry({ id: EQ(2), patient_id: null, category_code: 'booking', subject: 'Synthetic subject two', status: 'answered', last_message_at: '2026-11-03T10:00:00.000Z', version: 4 }),
  enquiry({ id: EQ(3), patient_id: null, category_code: 'payment', subject: 'Synthetic subject three', status: 'closed', last_message_at: '2026-11-02T09:00:00.000Z', closed_at: '2026-11-02T09:00:00.000Z', version: 5 }),
  enquiry({ id: EQ(4), account_id: ACC2, patient_id: PAT2, category_code: 'other', subject: 'Synthetic subject four (other account)', last_message_at: '2026-11-04T11:00:00.000Z', version: 1, created_by: MEMBERSHIP[ACC2], updated_by: MEMBERSHIP[ACC2] }),
  enquiry({ id: EQ(5), tenant_id: TB, account_id: ACC_B, patient_id: PAT_B, subject: 'Synthetic subject five (other tenant)', version: 1, created_by: MEMBERSHIP[ACC_B], updated_by: MEMBERSHIP[ACC_B] }),
];
export const seedMessages = (): Row[] => [
  message({ id: MS(1), enquiry_id: EQ(1) }),
  message({ id: MS(2), enquiry_id: EQ(2), body: 'Synthetic patient question two', created_at: '2026-11-03T09:00:00.000Z' }),
  message({ id: MS(3), enquiry_id: EQ(2), author_kind: 'staff', author_id: STAFF, created_by: STAFF, body: 'Synthetic lab answer two', created_at: '2026-11-03T10:00:00.000Z' }),
  message({ id: MS(4), enquiry_id: EQ(3), body: 'Synthetic patient question three', created_at: '2026-11-02T08:00:00.000Z' }),
  message({ id: MS(5), enquiry_id: EQ(3), author_kind: 'staff', author_id: STAFF, created_by: STAFF, body: 'Synthetic lab answer three', created_at: '2026-11-02T09:00:00.000Z' }),
  message({ id: MS(6), enquiry_id: EQ(4), account_id: ACC2, author_id: ACC2, created_by: MEMBERSHIP[ACC2], body: 'Synthetic other-account message', created_at: '2026-11-04T11:00:00.000Z' }),
  message({ id: MS(7), tenant_id: TB, enquiry_id: EQ(5), account_id: ACC_B, author_id: ACC_B, created_by: MEMBERSHIP[ACC_B], body: 'Synthetic other-tenant message' }),
];

// ---- SELECT evaluator ------------------------------------------------------------------------------------------------------------------------------------
const unsupported = (t: string): never => { throw new Error(`enquiries-world: unsupported ${t}`); };
export function selectGeneric(rows: Row[], text: string, values: unknown[], now: string): { rows: Row[]; rowCount: number } {
  let t = text.replace(/\s+for\s+update(?:\s+skip\s+locked)?\s*;?\s*$/i, '');
  if (/\b(join|group\s+by|having|union|offset|distinct|with)\b/i.test(t)) unsupported(`SELECT shape (join/group/offset/..): ${text}`);
  const f = /\bfrom\s+(?:engagement\.)?(\w+)(?:\s+(?:as\s+)?(?!where\b|order\b|limit\b)(\w+))?/i.exec(t);
  if (!f) return unsupported(`SELECT shape: ${text}`);
  const alias = f[2];
  t = t.replace(f[0], 'FROM notifications');
  if (alias) t = t.replace(new RegExp(`\\b${alias}\\.`, 'g'), '');
  t = t.replace(/\b(?:engagement\.)?(?:enquiries|enquiry_messages|notifications)\./gi, '');
  t = t.replace(/(\w+)\s+IN\s*\(([^()]*)\)/gi, (_m, c: string, list: string) => `(${list.split(',').map((x) => `${c} = ${x.trim()}`).join(' OR ')})`);
  const count = /^\s*select\s+count\(\s*\*\s*\)(?:\s*::\s*\w+)?(?:\s+as\s+(\w+))?\s+from/i.exec(t);
  if (count) t = t.replace(/^\s*select\s+.+?\s+from/is, 'SELECT * FROM');
  const out = selectNotifications(rows, t, values, now);
  if (count) { const row: Row = { count: out.length }; if (count[1]) row[count[1]] = out.length; return { rows: [row], rowCount: 1 }; }
  return { rows: out, rowCount: out.length };
}

// ---- world ---------------------------------------------------------------------------------------------------------------------------------------------
export function makeWorld(o: { now?: string; enabled?: boolean; seed?: (w: { tables: Record<string, Row[]> }) => void } = {}) {
  const clock = { iso: o.now ?? NOW };
  const tables: Record<string, Row[]> = {
    enquiries: seedEnquiries(), enquiry_messages: seedMessages(), notifications: [],
    settings: [{ id: ID(0x5e1), tenant_id: TA, enquiries_enabled: o.enabled ?? true, version: 1 }, { id: ID(0x5e2), tenant_id: TB, enquiries_enabled: true, version: 1 }],
    accounts: [{ id: ACC1, tenant_id: TA, membership_id: MEMBERSHIP[ACC1], status: 'active' }, { id: ACC2, tenant_id: TA, membership_id: MEMBERSHIP[ACC2], status: 'active' }, { id: ACC_B, tenant_id: TB, membership_id: MEMBERSHIP[ACC_B], status: 'active' }],
    account_patient_links: [
      { id: LINK1, tenant_id: TA, account_id: ACC1, patient_id: PAT1, display_name: 'Synthetic Patient One', relationship: 'self', status: 'active', version: 1 },
      { id: LINK3, tenant_id: TA, account_id: ACC1, patient_id: PAT3, display_name: 'Synthetic Patient Three', relationship: 'child', status: 'suspended', version: 2 },
      { id: LINK_ACC2, tenant_id: TA, account_id: ACC2, patient_id: PAT2, display_name: 'Synthetic Patient Two', relationship: 'self', status: 'active', version: 1 },
      { id: LINK_B, tenant_id: TB, account_id: ACC_B, patient_id: PAT_B, display_name: 'Synthetic Patient B', relationship: 'self', status: 'active', version: 1 },
    ],
  };
  o.seed?.({ tables });
  const db = new FakeDb(tables, schemaDefs(clock), clock);
  // RLS PAT_ACC for UPDATE / INSERT inside FakeDb (a request must not see or write another account's row, even while other requests interleave): scope.account set by session().
  const tenantVisible = (FakeDb.prototype as any).visible as (r: Row, t: string, s: unknown) => boolean;
  (db as any).visible = (r: Row, t: string, sc: any) => tenantVisible.call(db, r, t, sc) && (!sc?.account || r['account_id'] === undefined || r['account_id'] === sc.account);
  const audit = { access: [] as any[], event: [] as any[] };
  const logs: unknown[][] = [], metrics: unknown[][] = [], portCalls: Array<{ port: string; method: string; args: unknown[] }> = [];
  const grants = new Set<string>(Object.values(P));
  const identity = {
    asserted: [] as Array<{ permission: string; at: number }>, deny: new Set<string>(),
    async assertRole(_ctx: unknown, r: { permission: string }) {
      identity.asserted.push({ permission: r?.permission, at: db.calls.length });
      if (identity.deny.has(r?.permission) || !grants.has(r?.permission)) throw new LimsError('auth.forbidden');
    },
  };
  const ports: any = new Proxy({ IdentityPort: identity } as Record<string, unknown>, { // any other port (SMS, outbox, ..) is recorded, never real
    get: (t, k) => (typeof k !== 'string' || k in t ? (t as any)[k] : new Proxy({}, { get: (_x, m) => (...args: unknown[]) => { portCalls.push({ port: k, method: String(m), args }); return Promise.resolve(undefined); } })),
  });
  const advisory = new Map<string, Row>();
  const ctxFor = makeCtxFor();

  /** actor 'patient' (PAT_ACC of `account`) | 'staff' (tenant-wide); tenant A unless `tenant` is B. `release()` frees row / advisory locks (call when the request is done). */
  const session = (who: 'patient' | 'staff' = 'patient', over: Record<string, unknown> = {}, tenant = TA, account = ACC1) => {
    const s = db.session(tenant, { all: true, centres: [], ...(who === 'patient' ? { account } : {}) } as never, who === 'staff' ? (tenant === TB ? STAFF_B : STAFF) : MEMBERSHIP[account]);
    const patientIds = () => tables['account_patient_links']!.filter((l) => l['tenant_id'] === tenant && l['account_id'] === account && l['status'] === 'active').map((l) => l['patient_id']);
    const own = (tbl: string) => (r: Row) => r['tenant_id'] === tenant
      && (who !== 'patient' || !['enquiries', 'enquiry_messages', 'notifications', 'account_patient_links'].includes(tbl) || r['account_id'] === account)
      && (who !== 'patient' || tbl !== 'accounts' || r['id'] === account);
    const wait = async (row: Row) => { for (let spins = 0; db.locks.has(row) && db.locks.get(row) !== s.id; spins++) { if (spins > 3000) throw new Error('enquiries-world: lock wait timeout'); await new Promise<void>((r) => setTimeout(r, 1)); } db.locks.set(row, s.id); };
    const tx = {
      async query(text: string, values: unknown[] = []) {
        if (/pg_try_advisory/i.test(text)) unsupported('pg_try_advisory_*');
        if (/pg_advisory_(xact_)?lock/i.test(text)) { // serialise on the bound arguments (+ literal arguments in the text)
          db.calls.push({ text, values });
          const key = JSON.stringify([text.replace(/\s+/g, ' ').match(/pg_advisory_(?:xact_)?lock\s*\(([^)]*(?:\([^)]*\))?[^)]*)\)/i)?.[1] ?? '', values]);
          if (!advisory.has(key)) advisory.set(key, {});
          await new Promise<void>((r) => setImmediate(r));
          await wait(advisory.get(key)!);
          return { rows: [{}], rowCount: 1 } as any;
        }
        const verb = /^\s*(select|insert|update|delete)\b/i.exec(text)?.[1]?.toLowerCase();
        const tbl = /\b(?:from|update|into)\s+(?:engagement\.)?(\w+)/i.exec(text)?.[1];
        if (verb === 'select' && (tbl === 'enquiries' || tbl === 'enquiry_messages' || tbl === 'notifications')) {
          db.calls.push({ text, values });
          await new Promise<void>((r) => setImmediate(r));
          const res = selectGeneric(tables[tbl]!.filter(own(tbl)), text, values, clock.iso);
          if (/\bfor\s+update\b/i.test(text)) { // lock the matched rows (the evaluator returns copies: match them back by id)
            const skip = /skip\s+locked/i.test(text); const keep: Row[] = [];
            for (const c of res.rows) {
              const live = tables[tbl]!.find((r) => r['id'] === c['id'] && r['tenant_id'] === c['tenant_id'])!;
              if (skip && db.locks.has(live) && db.locks.get(live) !== s.id) continue;
              await wait(live); keep.push({ ...live });
            }
            return { rows: keep, rowCount: keep.length } as any;
          }
          return res as any;
        }
        const denied = (m: string) => Object.assign(new Error(`new row violates row-level security policy (${m})`), { code: '42501' });
        if (verb === 'insert' && tbl === 'notifications') throw denied('notifications INSERT is SYS only'); // 05-SCHEMA §5.2 RLS table (line 1347): PAT_ACC updates read_at only, staff cannot insert; 02-TRD §4.9 system actor creates rows
        if (verb === 'insert' && (tbl === 'enquiries' || tbl === 'enquiry_messages')) {
          const cols = /\(\s*([^)]*?)\s*\)\s*values/is.exec(text)?.[1]?.split(',').map((c) => c.trim()) ?? [];
          const vals = /\bvalues\s*\(([\s\S]*)\)\s*(?:on\s+conflict[\s\S]*)?(?:returning[\s\S]*)?;?\s*$/i.exec(text)?.[1] ?? '';
          const lit = (c: string): unknown => { const i = cols.indexOf(c); if (i < 0) return undefined; const e = vals.split(',')[i]?.trim() ?? ''; const m = /^\$(\d+)/.exec(e); return m ? values[+m[1]! - 1] : /^'(.*)'$/.exec(e)?.[1] ?? (/^null$/i.test(e) ? null : undefined); };
          if (tbl === 'enquiries') {
            if (who !== 'patient') throw denied('only the patient creates an enquiry');
            if (lit('account_id') !== account) throw denied('account_id is not the caller\'s account');
            const pid = lit('patient_id'); if (pid !== null && pid !== undefined && !patientIds().includes(pid)) throw denied('patient_id is not an active link of the account');
          } else {
            const kind = lit('author_kind');
            if (who === 'patient' ? kind !== 'patient' || lit('account_id') !== account : kind !== 'staff') throw denied(`author_kind ${String(kind)}`);
          }
        }
        const res: any = await s.tx.query(text, values);
        if (who === 'patient' && verb === 'select' && (tbl === 'account_patient_links' || tbl === 'accounts')) { res.rows = res.rows.filter(own(tbl)); res.rowCount = res.rows.length; }
        return res;
      },
    };
    const actorId = who === 'patient' ? MEMBERSHIP[account]! : tenant === TB ? STAFF_B : STAFF;
    const tenantKey = tenant === TB ? 'B' : 'A';
    const sink = (acc: unknown[][]) => ({ info: (...a: unknown[]) => { acc.push(a); }, warn: (...a: unknown[]) => { acc.push(a); }, error: (...a: unknown[]) => { acc.push(a); }, debug: (...a: unknown[]) => { acc.push(a); }, child() { return this; } });
    const base: any = ctxFor(`${tenantKey}:${who === 'staff' ? 'user' : 'patient'}`, { tx: tx as never, now: () => clock.iso, ports });
    const ctx = { ...base, actor: { type: who === 'staff' ? 'user' : 'patient', id: actorId }, audit: { access: async (e: unknown) => { audit.access.push(e); }, event: async (e: unknown) => { audit.event.push(e); } },
      operationId: 'x', clientIp: '203.0.113.9', log: sink(logs), metrics: { inc: (...a: unknown[]) => { metrics.push(a); }, set: (...a: unknown[]) => { metrics.push(a); }, observe: (...a: unknown[]) => { metrics.push(a); } }, ...over } as any;
    return { ctx, release: s.release, actorId };
  };
  return {
    db, tables, clock, identity, audit, grants, logs, metrics, portCalls, session,
    get stmts() { return db.calls; },
    writes: () => db.calls.filter((c) => /^\s*(insert|update|delete)\b/i.test(c.text)),
    enquiry: (id: string) => tables['enquiries']!.find((e) => e['id'] === id),
    messages: (id: string) => tables['enquiry_messages']!.filter((m) => m['enquiry_id'] === id),
  };
}
export type World = ReturnType<typeof makeWorld>;
