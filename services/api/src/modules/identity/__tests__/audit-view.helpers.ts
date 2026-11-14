// C2-T18 test helpers (not a test file). Synthetic data only.
// An in-memory fake of ONE Postgres transaction for the audit viewer (audit.audit_log, audit.access_log, identity.auth_events, core.users/memberships names).
// It models, by SQL CONTENT (never by statement position). RLS is deliberately OFF, so a statement WITHOUT a predicate sees every tenant's / centre's rows:
//   - `col = $n` (also `t.col = $n::uuid`) and `col = ANY ($n[::uuid[]])` as equality filters (a NULL argument does not narrow: optional filters)
//   - `occurred_at >= | > | <= | < $n`, `occurred_at BETWEEN $a AND $b`
//   - keyset paging on (occurred_at, id): `(occurred_at, id) < ($a, $b)` or `occurred_at < $a OR (occurred_at = $a AND id < $b)` (also `>`)
//   - the CR-C2-010 centre clause: any statement containing `centre_id IS NULL` keeps rows with centre_id NULL, or scope.all, or centre_id in the
//     `ANY ($n..)` array param (else the scenario's centreScope ids, as app.current_centre_ids() would give)
//   - ORDER BY occurred_at ASC|DESC (+ id tie-break in the same direction) and LIMIT $n | LIMIT <int>
//   - plain-column aliases `col AS alias` in the select list; `display_name` / `actor_display_name` columns when the text mentions display_name (JOIN style)
//   - INSERT INTO audit.access_log (cols) VALUES ($1, ...) and ctx.audit.access({...}) are BOTH recorded in `accessWrites` (either channel may be used)
// Anything else (set_config, ...) answers []. Documented in .orchestra/notes/T18-tests.md.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** contracts/openapi/identity.yaml parsed as-is (core loadSpec() currently trips on a bffSession ref collision in it; not T18's concern). */
export const readIdentitySpec = (): any => parse(readFileSync(join(import.meta.dirname, '../../../../../../contracts/openapi/identity.yaml'), 'utf8'));
export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const idN = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE_A1 = idN(0xc1);
export const CENTRE_A2 = idN(0xc2);
export const CENTRE_B1 = idN(0xcb);
export const USER_A = idN(0x4001);   // viewer + actor in tenant A
export const MEM_A = idN(0x3001);
export const USER_A2 = idN(0x4002);
export const MEM_A2 = idN(0x3002);
export const USER_B = idN(0x40b1);   // exists in tenant B only
export const MEM_B = idN(0x30b1);
export const USER_GONE = idN(0x4999); // unknown everywhere
export const PHI_SENTINEL = 'PHI-SENTINEL-OLD-8842';
export const T0 = Date.parse('2026-11-01T00:00:00.000Z');
export const FROM = '2026-11-01T00:00:00.000Z';
export const TO = '2026-11-08T00:00:00.000Z';

export type Row = Record<string, any>;
export const pgError = (code: string, message = 'db error') => Object.assign(new Error(message), { code });

export const auditRow = (n: number, over: Row = {}): Row => ({
  id: idN(0x1000 + n), tenant_id: TENANT_A, centre_id: null, schema_name: 'core', table_name: 'roles', row_id: idN(0x2000 + n), action: 'UPDATE',
  changed_columns: ['display_name'], old_values: { display_name: `${PHI_SENTINEL}-${n}` }, new_values: { display_name: `New ${n}` },
  actor_id: USER_A, actor_type: 'user', membership_id: MEM_A, support_session_id: null, request_id: idN(0x3000 + n),
  client_ip: '10.0.0.5', user_agent: 'Mozilla/5.0', occurred_at: new Date(T0 + n * 60_000), created_at: new Date(T0 + n * 60_000), created_by: USER_A, ...over,
});
export const accessRow = (n: number, over: Row = {}): Row => ({
  id: idN(0x5000 + n), tenant_id: TENANT_A, centre_id: null, actor_id: USER_A, actor_type: 'user', membership_id: MEM_A, support_session_id: null,
  action: 'audit_entry.view', entity_type: 'audit_entry', entity_id: idN(0x1000 + n), purpose_code: null, outcome: 'allowed', detail: { k: 'v' },
  request_id: idN(0x6000 + n), client_ip: '10.0.0.5', user_agent: 'Mozilla/5.0', occurred_at: new Date(T0 + n * 60_000), created_at: new Date(T0 + n * 60_000), created_by: USER_A, ...over,
});
export const authRow = (n: number, over: Row = {}): Row => ({
  id: idN(0x7000 + n), tenant_id: TENANT_A, user_id: USER_A, membership_id: MEM_A, platform_staff_id: null, session_id: null, event_type: 'login_succeeded',
  reason_code: null, email_hmac: Buffer.alloc(32, 9), client_ip: '10.0.0.5', user_agent: 'Mozilla/5.0', request_id: idN(0x8000 + n),
  occurred_at: new Date(T0 + n * 60_000), created_at: new Date(T0 + n * 60_000), created_by: USER_A, ...over,
});

export interface Seed { audit_log?: Row[]; access_log?: Row[]; auth_events?: Row[]; people?: Row[] }
export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly verb: string; readonly seq: number; returned: number; tenantPredicate: boolean }
export interface Scope { all: boolean; centreIds: string[] }

const DEFAULT_PEOPLE: Row[] = [
  { tenant_id: TENANT_A, user_id: USER_A, membership_id: MEM_A, display_name: 'Demo Lab Admin' },
  { tenant_id: TENANT_A, user_id: USER_A2, membership_id: MEM_A2, display_name: 'Demo Technician' },
  { tenant_id: TENANT_B, user_id: USER_B, membership_id: MEM_B, display_name: 'Beta Person' },
];
const TABLES: Record<string, keyof Seed> = { 'audit.audit_log': 'audit_log', 'audit.access_log': 'access_log', 'identity.auth_events': 'auth_events' };
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const cmp = (a: [number, string], b: [number, string]) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

export function makeEnv(seed: Seed = {}, opts: { scope?: Scope; failAccess?: boolean; failOn?: Array<{ match: RegExp; error: () => Error }> } = {}) {
  const store = {
    audit_log: (seed.audit_log ?? []).map((r) => ({ ...r })), access_log: (seed.access_log ?? []).map((r) => ({ ...r })),
    auth_events: (seed.auth_events ?? []).map((r) => ({ ...r })),
  };
  const people = seed.people ?? DEFAULT_PEOPLE;
  const stmts: Stmt[] = [];
  const accessWrites: Row[] = [];
  let seq = 0;
  let scope: Scope = opts.scope ?? { all: true, centreIds: [] };
  let failAccess = opts.failAccess ?? false;

  function select(text: string, values: readonly unknown[], stmt: Stmt): Row[] {
    const tName = [...text.matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());
    const audited = tName.find((t) => t in TABLES);
    if (!audited) {                                                             // display-name lookup (core.users / core.memberships)
      if (!tName.some((t) => t === 'core.users' || t === 'core.memberships')) return [];
      const byMem = tName.includes('core.memberships') && !tName.includes('core.users');
      let rows: Row[] = people.map((p) => ({ ...p, tenant_id: p.tenant_id, id: byMem ? p.membership_id : p.user_id, actor_id: p.user_id }));
      for (const [c, v] of eqFilters(text, values)) rows = rows.filter((r) => !(c in r) || r[c] === v);
      for (const [c, arr] of anyFilters(text, values)) rows = rows.filter((r) => !(c in r) || arr.includes(r[c]));
      stmt.tenantPredicate = /\btenant_id\s*=\s*\$\d+/.test(text);
      return rows;
    }
    let rows = store[TABLES[audited]!].map((r) => ({ ...r }));
    // keyset (strip first so its inner comparisons are not read as range / equality filters)
    let t = text;
    const keysets: Array<{ op: string; a: unknown; b: unknown }> = [];
    t = t.replace(/\(\s*(?:\w+\.)?occurred_at\s*,\s*(?:\w+\.)?id\s*\)\s*([<>])\s*\(\s*\$(\d+)(?:::\w+)?\s*,\s*\$(\d+)(?:::\w+)?\s*\)/gi,
      (_m, op, a, b) => { keysets.push({ op, a: values[Number(a) - 1], b: values[Number(b) - 1] }); return ' TRUE '; });
    t = t.replace(/\(?\s*(?:\w+\.)?occurred_at\s*([<>])\s*\$(\d+)(?:::\w+)?\s+OR\s*\(\s*(?:\w+\.)?occurred_at\s*=\s*\$\d+(?:::\w+)?\s+AND\s+(?:\w+\.)?id\s*[<>]\s*\$(\d+)(?:::\w+)?\s*\)\s*\)?/gi,
      (_m, op, a, b) => { keysets.push({ op, a: values[Number(a) - 1], b: values[Number(b) - 1] }); return ' TRUE '; });
    stmt.tenantPredicate = /\btenant_id\s*=\s*\$\d+/.test(t);
    for (const [c, v] of eqFilters(t, values)) rows = rows.filter((r) => !(c in r) || r[c] === v);
    for (const [c, arr] of anyFilters(t, values)) if (c !== 'centre_id') rows = rows.filter((r) => !(c in r) || arr.includes(r[c]));
    for (const m of t.matchAll(/(?:\b\w+\.)?occurred_at\s*(>=|<=|>|<)\s*\$(\d+)/gi)) {
      const v = ms(values[Number(m[2]) - 1]);
      rows = rows.filter((r) => { const o = ms(r.occurred_at); return m[1] === '>=' ? o >= v : m[1] === '>' ? o > v : m[1] === '<=' ? o <= v : o < v; });
    }
    for (const m of t.matchAll(/occurred_at\s+BETWEEN\s+\$(\d+)(?:::\w+)?\s+AND\s+\$(\d+)/gi)) {
      const lo = ms(values[Number(m[1]) - 1]); const hi = ms(values[Number(m[2]) - 1]);
      rows = rows.filter((r) => { const o = ms(r.occurred_at); return o >= lo && o <= hi; });
    }
    for (const k of keysets) {
      const key: [number, string] = [ms(k.a), String(k.b)];
      rows = rows.filter((r) => { const c = cmp([ms(r.occurred_at), r.id], key); return k.op === '<' ? c < 0 : c > 0; });
    }
    if (/centre_id\s+IS\s+NULL/i.test(t)) {                                     // CR-C2-010 centre clause
      const arrParam = /centre_id\s*=\s*ANY\s*\(\s*\(?\s*\$(\d+)/i.exec(t);
      const ids: unknown[] = arrParam ? (values[Number(arrParam[1]) - 1] as unknown[]) ?? [] : scope.centreIds;
      rows = rows.filter((r) => r.centre_id == null || scope.all || ids.includes(r.centre_id));
    }
    const dir = /order\s+by\s+(?:\w+\.)?occurred_at\s+asc/i.test(t) ? 1 : -1;
    rows.sort((a, b) => dir * cmp([ms(a.occurred_at), a.id], [ms(b.occurred_at), b.id]));
    const lim = /\blimit\s+(?:\$(\d+)|(\d+))/i.exec(t);
    if (lim) rows = rows.slice(0, lim[1] ? Number(values[Number(lim[1]) - 1]) : Number(lim[2]));
    // aliases of plain columns + JOIN-style display names
    const sel = /^\s*select\s+([\s\S]*?)\s+from\b/i.exec(text)?.[1] ?? '';
    const aliases = [...sel.matchAll(/(?:\b\w+\.)?(\w+)\s+AS\s+"?(\w+)"?/gi)].map((m) => [m[1]!, m[2]!] as const);
    return rows.map((r) => {
      for (const [col, al] of aliases) if (col in r) r[al] = r[col];
      if (/display_name/i.test(text)) {
        const p = people.find((x) => x.user_id === r.actor_id && x.tenant_id === r.tenant_id);
        r.display_name = p?.display_name ?? null; r.actor_display_name = r.display_name;
      }
      return r;
    });
  }

  function insertAccess(text: string, values: readonly unknown[]) {
    if (failAccess) throw pgError('XX000', 'access log write failed');
    const cols = /insert\s+into\s+audit\.access_log\s*\(([^)]*)\)/i.exec(text)?.[1]?.split(',').map((c) => c.trim()) ?? [];
    const vals = /values\s*\(([\s\S]*?)\)\s*(?:returning|$)/i.exec(text)?.[1]?.split(',').map((c) => c.trim()) ?? [];
    const row: Row = {};
    cols.forEach((c, i) => { const p = /^\$(\d+)/.exec(vals[i] ?? ''); row[c] = p ? values[Number(p[1]) - 1] : vals[i]; });
    accessWrites.push({ ...row, seq: ++seq, channel: 'tx' });
  }

  const tx = {
    async query(text: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      for (const f of opts.failOn ?? []) if (f.match.test(text)) throw f.error();
      const verb = (/^\s*(select|insert|update|delete|with)/i.exec(text)?.[1] ?? 'other').toLowerCase();
      const stmt: Stmt = { text, values, verb, seq: ++seq, returned: 0, tenantPredicate: false };
      stmts.push(stmt);
      if (/^\s*insert\s+into\s+audit\.access_log/i.test(text)) { insertAccess(text, values); return { rows: [], rowCount: 1 }; }
      if (verb !== 'select' && verb !== 'with') return { rows: [], rowCount: 0 };
      const rows = select(text, values, stmt);
      stmt.returned = rows.length;
      return { rows, rowCount: rows.length };
    },
  };
  const audit = {
    async access(entry: Row) {
      if (failAccess) throw pgError('XX000', 'access log write failed');
      accessWrites.push({ action: entry.action, entity_type: entry.entityType, entity_id: entry.entityId, centre_id: entry.centreId, outcome: entry.outcome,
        detail: entry.detail ?? {}, purpose_code: entry.purpose, seq: ++seq, channel: 'ctx.audit' });
    },
  };
  /** A request context as the (future) core pipeline builds it: tenant, actor, tx, centre scope, ctx.audit. */
  const ctx = (o: { tenantId?: string; actor?: Row; scope?: Scope } = {}) => ({
    operationId: 'test', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: o.tenantId ?? TENANT_A, requestId: idN(0xf1),
    actor: o.actor ?? { type: 'user', id: USER_A, membershipId: MEM_A },
    centreScope: o.scope ?? scope, tx, audit,
  });
  return {
    tx, audit, ctx, stmts, accessWrites, store,
    setScope(s: Scope) { scope = s; }, setFailAccess(b: boolean) { failAccess = b; },
    viewWrites: () => accessWrites.filter((w) => w.action === 'audit_entry.view'),
  };
}

function eqFilters(where: string, values: readonly unknown[]) {
  return [...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)(?:::\w+)?/g)].map((m) => [m[1]!, values[Number(m[2]) - 1]] as const)
    .filter(([, v]) => v !== null && v !== undefined);
}
function anyFilters(where: string, values: readonly unknown[]) {
  return [...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*ANY\s*\(\s*\$(\d+)(?:::\w+(?:\[\])?)?\s*\)/gi)].map((m) => [m[1]!, (values[Number(m[2]) - 1] as unknown[]) ?? []] as const);
}

/** Keys of an OpenAPI component schema (contracts/openapi/identity.yaml). */
export function schemaKeys(spec: any, name: string): { props: string[]; required: string[] } {
  const s = spec.components.schemas[name];
  return { props: Object.keys(s.properties), required: s.required ?? [] };
}
export const walk = async (page: (cursor?: string) => Promise<any>): Promise<{ ids: string[]; pages: number }> => {
  const ids: string[] = []; let cursor: string | undefined; let pages = 0;
  do { const b = await page(cursor); pages++; ids.push(...b.data.map((d: any) => d.audit_id ?? d.id ?? d.auth_event_id)); cursor = b.page.next_cursor; } while (cursor && pages < 500);
  return { ids, pages };
};
