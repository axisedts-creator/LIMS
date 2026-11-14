// C16.T-P5 test world (tester-owned): engagement.notifications / account_patient_links / accounts on the shared FakeDb (fakeSql.ts) for E45 listMyNotifications and
// E46 markMyNotificationsRead. Used by service/__tests__/notification.handlers.test.ts.
// FakeDb grammar has no row-value keyset (`(created_at, id) < (..)`) or OR, so a SELECT on notifications is answered by `selectNotifications` below: a small evaluator for
// WHERE (AND/OR/NOT, = <> != < <= > >=, IS [NOT] NULL, col = ANY($n), row-value compare, ::casts), ORDER BY col [ASC|DESC], .., LIMIT n|$n. Anything it cannot parse throws
// `notifications-world: unsupported ...` (loud, never a silent pass). UPDATE goes through FakeDb (the enforce_mutable_columns trigger models "PAT_ACC read_at only", 05-SCHEMA §8).
// RLS modelled (05-SCHEMA §8 notifications): tenant on every statement; a patient actor sees / updates only rows of ITS account (PAT_ACC) and links of its account.
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { FakeDb, type Row, type TableDef } from './fakeSql.js';

export const TA: string = TENANTS.A;
export const TB: string = TENANTS.B;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const P = { SELF_READ: 'engagement.self.read', SELF_MANAGE: 'engagement.self.manage' } as const;

export const PAT1 = ID(0x11), PAT2 = ID(0x12), PAT3 = ID(0x13), PAT_B = ID(0x1b);
export const ACC1 = ID(0xa1), ACC2 = ID(0xa2), ACC_B = ID(0xab);
export const LINK1 = ID(0xc1), LINK3 = ID(0xc3), LINK_ACC2 = ID(0xc4), LINK_B = ID(0xcb);
export const STAFF = ID(0x5f), SYSTEM = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const NID = (n: number) => ID(0x900 + n);
export const ENT = (n: number) => ID(0xe00 + n);

const KINDS = ['report_ready', 'sample_recollection', 'booking_confirmed', 'booking_cancelled', 'booking_reminder', 'payment_completed', 'follow_up_reminder', 'enquiry_reply', 'profile_paused'];
const ENTITIES = ['order', 'report', 'booking', 'enquiry', 'reminder', 'profile'];
const ROUTES = ['patient_app.report', 'patient_app.order', 'patient_app.booking'];
export const NOTIFICATION_COLUMNS = ['id', 'tenant_id', 'account_id', 'patient_id', 'kind', 'entity_type', 'entity_id', 'entity_seq', 'route_id', 'read_at', 'created_at', 'created_by', 'expires_at'] as const;

const T = (columns: string[], more: Partial<TableDef> = {}): TableDef => ({ columns, ...more });
export const schemaDefs = (): Record<string, TableDef> => ({
  notifications: T([...NOTIFICATION_COLUMNS], {
    notNull: ['id', 'tenant_id', 'account_id', 'kind', 'entity_seq', 'created_at', 'created_by', 'expires_at'],
    defaults: { entity_seq: 0, patient_id: null, entity_type: null, entity_id: null, route_id: null, read_at: null },
    unique: [['id'], ['tenant_id', 'id']],
    mutable: ['read_at'], // 05-SCHEMA §8: PAT_ACC updates read_at only
    check: (r) => (!KINDS.includes(r['kind']) ? 'notifications__kind__ck'
      : r['entity_type'] != null && !ENTITIES.includes(r['entity_type']) ? 'notifications__entity__ck'
      : r['route_id'] != null && !ROUTES.includes(r['route_id']) ? 'notifications__route__ck' : undefined),
  }),
  accounts: T(['id', 'tenant_id', 'membership_id', 'status'], { unique: [['id']] }),
  account_patient_links: T(['id', 'tenant_id', 'account_id', 'patient_id', 'display_name', 'relationship', 'status', 'version'], { unique: [['id']] }),
});

/** A stored notification row: ONLY the 05-SCHEMA columns (no text column exists). */
export const note = (o: Row = {}): Row => ({ id: NID(1), tenant_id: TA, account_id: ACC1, patient_id: PAT1, kind: 'report_ready', entity_type: 'order', entity_id: ENT(1), entity_seq: 0, route_id: 'patient_app.report', read_at: null,
  created_at: '2026-11-04T10:00:00.000Z', created_by: SYSTEM, expires_at: '2027-05-03T10:00:00.000Z', ...o });

export const seedNotifications = (): Row[] => [
  note({ id: NID(1), created_at: '2026-11-04T10:00:00.000Z' }), // own, unread, links to PAT1 (active link LINK1)
  note({ id: NID(2), kind: 'booking_confirmed', entity_type: 'booking', entity_id: ENT(2), route_id: 'patient_app.booking', read_at: '2026-11-04T09:30:00.000Z', created_at: '2026-11-04T09:00:00.000Z' }), // own, already read
  note({ id: NID(3), kind: 'follow_up_reminder', entity_type: 'reminder', entity_id: ENT(3), route_id: null, created_at: '2026-11-03T08:00:00.000Z' }), // own, no route
  note({ id: NID(4), kind: 'profile_paused', entity_type: 'profile', entity_id: ENT(4), route_id: null, patient_id: PAT3, created_at: '2026-11-02T08:00:00.000Z' }), // own, suspended link
  note({ id: NID(5), kind: 'enquiry_reply', entity_type: 'enquiry', entity_id: ENT(5), route_id: null, patient_id: null, created_at: '2026-11-01T08:00:00.000Z' }), // own, no patient
  note({ id: NID(6), account_id: ACC2, patient_id: PAT2, entity_id: ENT(6), created_at: '2026-11-04T11:00:00.000Z' }), // OTHER account, same tenant
  note({ id: NID(7), tenant_id: TB, account_id: ACC_B, patient_id: PAT_B, entity_id: ENT(7), created_at: '2026-11-04T12:00:00.000Z' }), // OTHER tenant
];

// ---- SELECT evaluator for notifications -----------------------------------------------------------------------------------------------------------------
const unsupported = (t: string): never => { throw new Error(`notifications-world: unsupported ${t}`); };
const isoOf = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
function tupleCmp(a: unknown[], b: unknown[], op: string): boolean {
  let c = 0;
  for (let i = 0; i < a.length && c === 0; i++) { const x: any = isoOf(a[i]), y: any = isoOf(b[i]); c = x < y ? -1 : x > y ? 1 : 0; }
  return ({ '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '=': c === 0, '<>': c !== 0 } as Record<string, boolean>)[op] ?? unsupported(`row operator ${op}`);
}
function compileWhere(src: string, now: string): (r: Row, v: unknown[]) => boolean {
  let s = src.replace(/::\w+(\[\])?/g, '').replace(/\bnow\(\)/gi, 'NOW_').replace(/\b(?:engagement\.)?\bnotifications\.|\bn\./gi, '');
  s = s.replace(/\(\s*([\w\s,]+?)\s*\)\s*(<=|>=|<>|<|>|=)\s*\(\s*([^()]*?)\s*\)/g, (_m, l: string, op: string, r: string) => `TUP([${l.split(',').map((x) => `'${x.trim()}'`).join(',')}],[${r}],'${op}')`);
  s = s.replace(/(\w+)\s+IS\s+NOT\s+NULL/gi, "NN('$1',true)").replace(/(\w+)\s+IS\s+NULL/gi, "NN('$1',false)");
  s = s.replace(/(\w+)\s*=\s*ANY\s*\(\s*(\$\d+)\s*\)/gi, "ANYOF('$1',$2)");
  const out = s.replace(/'[^']*'|\$\d+|<=|>=|<>|!=|=|<|>|\b(?:TUP|NN|ANYOF|CMP|AND|OR|NOT)\b|[A-Za-z_]\w*\b(?!\s*\()|\(|\)|,|\s+|\S/g, (t) => {
    if (/^'/.test(t) || /^\s+$/.test(t) || t === '(' || t === ')' || t === ',' || t === '[' || t === ']') return t;
    if (/^\$\d+$/.test(t)) return `V[${+t.slice(1) - 1}]`;
    if (t === '=') return '===';
    if (t === '<>' || t === '!=') return '!==';
    if (t === '<=' || t === '>=' || t === '<' || t === '>') return t;
    if (/^and$/i.test(t)) return '&&';
    if (/^or$/i.test(t)) return '||';
    if (/^not$/i.test(t)) return '!';
    if (/^(true|false|null)$/i.test(t)) return t.toLowerCase();
    if (/^(TUP|NN|ANYOF|CMP)$/.test(t)) return t;
    if (/^(and|or|not)$/i.test(t)) return /^and$/i.test(t) ? '&&' : /^or$/i.test(t) ? '||' : '!';
    if (t === 'NOW_') return 'NOW';
    if (/^[A-Za-z_]\w*$/.test(t)) return `C('${t}')`;
    return unsupported(`token "${t}" in WHERE ${src}`);
  });
  const cmpFix = out.replace(/(C\('\w+'\)|V\[\d+\])\s*(<=|>=|<|>|===|!==)\s*(C\('\w+'\)|V\[\d+\])/g, (_m, a: string, op: string, b: string) => `CMP(${a},${b},'${op}')`);
  let fn: (...a: any[]) => boolean;
  try { fn = new Function('R', 'V', 'NOW', 'TUP', 'NN', 'ANYOF', 'CMP', `const C=(k)=>R[k]; return !!(${cmpFix});`) as never; } catch { return unsupported(`WHERE ${src}`); }
  return (r, v) => fn(r, v, now, (cols: string[], vals: unknown[], op: string) => tupleCmp(cols.map((c) => r[c]), vals, op),
    (c: string, notNull: boolean) => (r[c] != null) === notNull, (c: string, arr: unknown[]) => Array.isArray(arr) && arr.includes(r[c]),
    (a: unknown, b: unknown, op: string) => tupleCmp([a], [b], op === '===' ? '=' : op === '!==' ? '<>' : op));
}
export function selectNotifications(rows: Row[], text: string, values: unknown[], now: string): Row[] {
  const m = /^\s*select\s+(.+?)\s+from\s+(?:engagement\.)?notifications\b(?:\s+\w+)?(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+(.+?))?(?:\s+limit\s+(\$\d+|\d+))?\s*;?\s*$/is.exec(text);
  if (!m) return unsupported(`SELECT shape: ${text}`);
  const where = m[2] ? compileWhere(m[2], now) : () => true;
  let out = rows.filter((r) => where(r, values));
  if (m[3]) {
    const keys = m[3].split(',').map((k) => { const p = /^\s*(?:\w+\.)?(\w+)(?:\s+(asc|desc))?\s*$/i.exec(k); return p ? { c: p[1]!, d: (p[2] ?? 'asc').toLowerCase() === 'desc' ? -1 : 1 } : unsupported(`ORDER BY ${k}`); });
    out = [...out].sort((a, b) => { for (const k of keys) { const x: any = isoOf(a[k.c]), y: any = isoOf(b[k.c]); if (x !== y) return (x < y ? -1 : 1) * k.d; } return 0; });
  }
  if (m[4]) { const n = m[4].startsWith('$') ? Number(values[+m[4].slice(1) - 1]) : Number(m[4]); if (!Number.isInteger(n) || n < 0) unsupported(`LIMIT ${m[4]}`); out = out.slice(0, n); }
  return out.map((r) => ({ ...r }));
}

// ---- world ---------------------------------------------------------------------------------------------------------------------------------------------
export function makeWorld(o: { now?: string; seed?: (w: { tables: Record<string, Row[]> }) => void } = {}) {
  const clock = { iso: o.now ?? '2026-11-05T04:15:00.000Z' };
  const tables: Record<string, Row[]> = {
    notifications: seedNotifications(),
    accounts: [{ id: ACC1, tenant_id: TA, membership_id: ID(0xe1), status: 'active' }, { id: ACC2, tenant_id: TA, membership_id: ID(0xe2), status: 'active' }, { id: ACC_B, tenant_id: TB, membership_id: ID(0xeb), status: 'active' }],
    account_patient_links: [
      { id: LINK1, tenant_id: TA, account_id: ACC1, patient_id: PAT1, display_name: 'Synthetic Patient One', relationship: 'self', status: 'active', version: 1 },
      { id: LINK3, tenant_id: TA, account_id: ACC1, patient_id: PAT3, display_name: 'Synthetic Patient Three', relationship: 'child', status: 'suspended', version: 2 },
      { id: LINK_ACC2, tenant_id: TA, account_id: ACC2, patient_id: PAT2, display_name: 'Synthetic Patient Two', relationship: 'self', status: 'active', version: 1 },
      { id: LINK_B, tenant_id: TB, account_id: ACC_B, patient_id: PAT_B, display_name: 'Synthetic Patient B', relationship: 'self', status: 'active', version: 1 },
    ],
  };
  o.seed?.({ tables });
  const db = new FakeDb(tables, schemaDefs(), clock);
  const audit = { access: [] as any[], event: [] as any[] };
  const grants = new Set<string>(Object.values(P));
  const identity = {
    asserted: [] as Array<{ permission: string; at: number }>, deny: new Set<string>(),
    async assertRole(_ctx: unknown, r: { permission: string }) {
      identity.asserted.push({ permission: r?.permission, at: db.calls.length });
      if (identity.deny.has(r?.permission) || !grants.has(r?.permission)) throw new LimsError('auth.forbidden');
    },
  };
  const ctxFor = makeCtxFor();
  /** actor 'patient' (PAT_ACC of `account`) | 'staff' | 'system'; tenant A unless `tenant` is B. */
  const session = (who: 'patient' | 'staff' | 'system' = 'patient', over: Record<string, unknown> = {}, tenant = TA, account = ACC1) => {
    const s = db.session(tenant, { all: true, centres: [] }, who === 'system' ? SYSTEM : STAFF);
    const tx = {
      async query(text: string, values: unknown[] = []) {
        const tbl = /\b(?:from|update|into)\s+(?:engagement\.)?(\w+)/i.exec(text)?.[1];
        const own = (r: Row) => r['tenant_id'] === tenant && (who !== 'patient' || tbl !== 'notifications' && tbl !== 'account_patient_links' || r['account_id'] === account) && (who !== 'patient' || tbl !== 'accounts' || r['id'] === account);
        if (/^\s*select/i.test(text) && tbl === 'notifications') {
          db.calls.push({ text, values });
          const rows = selectNotifications(tables['notifications']!.filter(own), text, values, clock.iso);
          return { rows, rowCount: rows.length } as any;
        }
        if (who === 'patient' && /^\s*update/i.test(text) && tbl === 'notifications') { // RLS: PAT_ACC sees (so updates) its own account's rows only
          const all = db.tables['notifications']!;
          db.tables['notifications'] = all.filter(own);
          try { return await s.tx.query(text, values); } finally { db.tables['notifications'] = all; }
        }
        const res: any = await s.tx.query(text, values);
        if (who === 'patient' && /^\s*select/i.test(text) && (tbl === 'account_patient_links' || tbl === 'accounts')) { res.rows = res.rows.filter(own); res.rowCount = res.rows.length; }
        return res;
      },
    };
    const actorId = who === 'patient' ? tables['accounts']!.find((a) => a['id'] === account)!['membership_id'] : who === 'system' ? SYSTEM : STAFF;
    const tenantKey = tenant === TB ? 'B' : 'A';
    const base: any = ctxFor(`${tenantKey}:${who === 'staff' ? 'user' : who}`, { tx: tx as never, now: () => clock.iso, ports: { IdentityPort: identity } as never });
    return { ...base, actor: { type: who === 'staff' ? 'user' : who, id: actorId }, audit: { access: async (e: unknown) => { audit.access.push(e); }, event: async (e: unknown) => { audit.event.push(e); } },
      operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} }, ...over } as any;
  };
  return {
    db, tables, clock, identity, audit, grants, session,
    get stmts() { return db.calls; },
    writes: () => db.calls.filter((c) => /^\s*(insert|update|delete)\b/i.test(c.text)),
    row: (id: string) => tables['notifications']!.find((n) => n['id'] === id),
  };
}
export type World = ReturnType<typeof makeWorld>;
