// C16.T-B1 test world (NOT a test file): in-memory engagement.bookable_items + CatalogPort/IdentityPort fakes shared by the API handler tests (S12-S14) and the worker tests
// (sync task, nightly cron, catalog.changed.v1 consumer). Same convention as reminders.world.ts: the fake `tx.query` answers by statement TYPE + table, never by exact SQL.
//   engagement.bookable_items: SELECT (filters from BOUND values: `id`/`orderable_id` = $n, `is_active` = $n, a bound search string when the SQL has LIKE/ILIKE/strpos/position,
//     keyset `(sort_order, display_name, id) > ($a,$b,$c)`, `LIMIT $n|literal`; always ordered sort_order, display_name, id), INSERT (cols) VALUES (...), UPDATE ... SET a = $n, version = version + 1 WHERE ...
//   `app.enqueue_job($1 identifier, $2 payload, $3 job_key, $4 run_at, $5 max_attempts)` (de-duplicated on identifier + job_key, like the real queue).
// RLS model: every row read/written is filtered to the SESSION tenant (ctx.tenantId); every statement on bookable_items must ALSO bind the tenant id (REQ-SEC-024, asserted by the tests).
// DB rules emulated from 05-SCHEMA bookable_items: UNIQUE (tenant_id, orderable_id) -> 23505, kind/kinds/sex/price/lengths/sort CHECKs -> 23514. Time = the fake clock.
import { LimsError } from '../../../core/errors.js';
import { ID, SYSTEM_ACTOR, T0, TENANT_A, TENANT_B } from './reminders.world.js';
export { ID, SYSTEM_ACTOR, T0, TENANT_A, TENANT_B };

type Row = Record<string, any>;
export interface Stmt { text: string; values: unknown[] }
const verbOf = (t: string) => /^\s*(select|insert|update|delete|with)\b/i.exec(t)?.[1]?.toLowerCase() ?? 'other';
const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });

// Synthetic catalogue (C3 ids are P0 uuids).
export const O = { CBC: ID(0x101), GLU: ID(0x102), LFT_INACTIVE: ID(0x103), UNPRICED: ID(0x104), WHP: ID(0x301), ANAEMIA: ID(0x302), UNKNOWN: ID(0x999) } as const;
export const PL = ID(0x201);
type Def = { kind: 'test' | 'panel'; code: string; name: string; isActive: boolean; sexRestriction?: 'male' | 'female'; paisa?: number; listVersion?: number; priceError?: Error };
const defaultDefs = (): Record<string, Def> => ({
  [O.CBC]: { kind: 'test', code: 'CBC', name: 'Complete Blood Count', isActive: true, paisa: 45000, listVersion: 3 },
  [O.GLU]: { kind: 'test', code: 'GLU', name: 'Glucose Fasting', isActive: true, paisa: 20000, listVersion: 3 },
  [O.LFT_INACTIVE]: { kind: 'test', code: 'LFT', name: 'Liver Function Test', isActive: false, paisa: 30000, listVersion: 3 },
  [O.UNPRICED]: { kind: 'test', code: 'UNP', name: 'Unpriced Test', isActive: true },
  [O.WHP]: { kind: 'panel', code: 'WHP', name: "Women's Health Package", isActive: true, sexRestriction: 'female', paisa: 250000, listVersion: 3 },
  [O.ANAEMIA]: { kind: 'panel', code: 'ANAEMIA', name: 'Anaemia Panel', isActive: true, paisa: 90000, listVersion: 3 },
});

export function makeBookableWorld() {
  const clock = { t: Date.parse(T0) };
  const now = () => new Date(clock.t).toISOString();
  const t: Record<string, Row[]> = { items: [], jobs: [] };
  const stmts: Stmt[] = [];
  let seq = 0xb000;
  const newId = () => ID(++seq);
  const defs = defaultDefs();

  const lit = (tok: string, values: unknown[]): unknown => {
    const p = /^\$(\d+)(::[\w\[\]]+)?$/.exec(tok); if (p) return values[Number(p[1]) - 1];
    if (/^'.*'$/.test(tok)) return tok.slice(1, -1);
    if (/^(now|clock_timestamp|transaction_timestamp)\(\)$/i.test(tok)) return now();
    if (/^null$/i.test(tok)) return null; if (/^true$/i.test(tok)) return true; if (/^false$/i.test(tok)) return false;
    if (/^-?\d+$/.test(tok)) return Number(tok);
    return undefined;
  };
  const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const refs = (text: string, values: unknown[]) => [...text.matchAll(/\$(\d+)/g)].map((m) => values[Number(m[1]) - 1]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function check(r: Row) {
    if (!['test', 'panel'].includes(r['orderable_kind'])) throw pgErr('23514', 'bookable_items__kind__ck');
    const k = r['booking_kinds']; if (!Array.isArray(k) || k.length < 1 || k.length > 2 || !k.every((x: string) => ['centre_visit', 'home_collection'].includes(x))) throw pgErr('23514', 'bookable_items__kinds__ck');
    if (r['sex_restriction'] != null && !['male', 'female'].includes(r['sex_restriction'])) throw pgErr('23514', 'bookable_items__sex__ck');
    if (r['indicative_price_paisa'] != null && Number(r['indicative_price_paisa']) < 0) throw pgErr('23514', 'bookable_items__price__ck');
    if (String(r['code'] ?? '').length < 1 || String(r['code']).length > 64 || String(r['display_name'] ?? '').length < 1 || String(r['display_name']).length > 200) throw pgErr('23514', 'bookable_items__lengths__ck');
    if (!(r['sort_order'] >= 0 && r['sort_order'] <= 9999)) throw pgErr('23514', 'bookable_items__sort__ck');
  }

  function exec(ctx: any, text: string, values: unknown[] = []): { rows: Row[]; rowCount: number } {
    stmts.push({ text, values });
    const sql = text.replace(/\s+/g, ' ').trim(); const verb = verbOf(sql); const tenant = ctx.tenantId as string;
    const ok = (rows: Row[], rowCount = rows.length) => ({ rows, rowCount });

    if (/app\.enqueue_job/i.test(sql)) {
      let payload: any = values[1]; if (typeof payload === 'string') payload = JSON.parse(payload);
      const job = { identifier: String(values[0]), payload, jobKey: values[2], runAt: values[3] ?? null, maxAttempts: values[4] ?? null, tenant };
      if (job.jobKey != null && t['jobs']!.some((j) => j['identifier'] === job.identifier && j['jobKey'] === job.jobKey)) return ok([{ enqueue_job: 1 }]);
      t['jobs']!.push(job); return ok([{ enqueue_job: 1 }]);
    }
    if (!/engagement\.bookable_items/i.test(sql)) return ok([], 0);   // session settings, audit, anything else

    const mine = () => t['items']!.filter((r) => r['tenant_id'] === tenant);
    if (verb === 'select') {
      const colEq = (col: string) => [...sql.matchAll(new RegExp(`(?<![\\w.])${col}\\s*=\\s*\\$(\\d+)`, 'gi'))].map((m) => values[Number(m[1]) - 1]);
      const ids = colEq('id'), oids = colEq('orderable_id'), act = colEq('is_active');
      let rows = mine();
      if (ids.length) rows = rows.filter((r) => ids.includes(r['id']));
      if (oids.length) rows = rows.filter((r) => oids.includes(r['orderable_id']));
      if (act.length) rows = rows.filter((r) => act.includes(r['is_active']));
      if (/\bi?like\b|strpos|position\(/i.test(sql)) {
        const q = values.find((v) => typeof v === 'string' && !UUID.test(v) && !/^\d{4}-\d\d-\d\dT/.test(v) && v !== 'test' && v !== 'panel');
        if (typeof q === 'string') { const needle = q.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase(); rows = rows.filter((r) => `${r['code']} ${r['display_name']}`.toLowerCase().includes(needle)); }
      }
      rows = [...rows].sort((a, b) => a['sort_order'] - b['sort_order'] || (a['display_name'] < b['display_name'] ? -1 : a['display_name'] > b['display_name'] ? 1 : 0) || (a['id'] < b['id'] ? -1 : 1));
      const cur = /\(\s*sort_order\s*,\s*display_name\s*,\s*id\s*\)\s*>\s*\(\s*\$(\d+)(?:::\w+)?\s*,\s*\$(\d+)(?:::\w+)?\s*,\s*\$(\d+)/i.exec(sql);
      if (cur) {
        const [so, dn, cid] = [Number(values[Number(cur[1]) - 1]), String(values[Number(cur[2]) - 1]), String(values[Number(cur[3]) - 1])];
        rows = rows.filter((r) => r['sort_order'] > so || (r['sort_order'] === so && (r['display_name'] > dn || (r['display_name'] === dn && r['id'] > cid))));
      }
      const lm = /limit\s+(?:\$(\d+)|(\d+))/i.exec(sql); if (lm) rows = rows.slice(0, lm[1] ? Number(values[Number(lm[1]) - 1]) : Number(lm[2]));
      return ok(rows.map((r) => structuredClone(r)));
    }
    if (verb === 'insert') {
      const m = /\(([^)]*)\)\s*values\s*\((.*?)\)\s*(?:on conflict|returning|$)/i.exec(sql); if (!m) throw new Error(`fake: cannot parse bookable_items INSERT: ${sql}`);
      const cols = m[1]!.split(',').map((c) => c.trim()); const toks = splitTop(m[2]!);
      const row: Row = { id: newId(), tenant_id: tenant, indicative_price_paisa: null, price_list_id: null, price_list_version: null, sex_restriction: null, sort_order: 1000, catalog_revision: null, synced_at: null, version: 1, is_active: true, created_at: now(), updated_at: now() };
      cols.forEach((c, i) => { row[c] = lit(toks[i]!, values); });
      if (t['items']!.some((r) => r['tenant_id'] === row['tenant_id'] && r['orderable_id'] === row['orderable_id'])) throw pgErr('23505', 'bookable_items__tenant_id_orderable_id__uq');
      check(row); t['items']!.push(row); return ok(/returning/i.test(sql) ? [structuredClone(row)] : [], 1);
    }
    if (verb === 'update') {
      const m = /set (.+?) where (.+?)(?: returning .*)?$/i.exec(sql); if (!m) throw new Error(`fake: cannot parse bookable_items UPDATE: ${sql}`);
      const whereVals = refs(m[2]!, values); const row = mine().find((r) => whereVals.includes(r['id']) || whereVals.includes(r['orderable_id']));
      if (!row) return ok([], 0);
      const nums = whereVals.filter((v) => typeof v === 'number'); if (nums.length && !nums.includes(row['version'])) return ok([], 0);   // optimistic lock
      const patch: Row = {}; let bump = false;
      for (const a of splitTop(m[1]!)) {
        const mm = /^(\w+)\s*=\s*(.+)$/.exec(a); if (!mm) continue; const rhs = mm[2]!.trim();
        if (/^version\s*\+\s*1$/i.test(rhs)) { bump = true; continue; }
        const co = /^coalesce\((.+),\s*(.+)\)$/i.exec(rhs); const v = lit(co ? co[2]! : rhs, values);
        if (v !== undefined) patch[mm[1]!] = v instanceof Date ? v.toISOString() : v;
      }
      const next = { ...row, ...patch, ...(bump ? { version: row['version'] + 1 } : {}), updated_at: now() }; check(next); Object.assign(row, next);
      return ok(/returning/i.test(sql) ? [structuredClone(row)] : [], 1);
    }
    if (verb === 'delete') throw new Error('bookable_items are never deleted (05-SCHEMA matrix: S I U)');
    return ok([], 0);
  }

  const tx = (ref: { current: any }) => ({ async query(text: string, values: unknown[] = []) { return exec(ref.current, text, values); } });

  // ---- ports ---------------------------------------------------------------------------------------------------------------------------------------------
  const identity = {
    asserted: [] as Array<{ permission: string; actor: string; at: number }>,
    deny: new Set<string>(),
    async assertRole(ctx: any, req: { permission: string }) {
      identity.asserted.push({ permission: req.permission, actor: ctx.actor.type, at: stmts.length });
      if (identity.deny.has(req.permission)) throw new LimsError('auth.forbidden');
    },
  };
  const catalog = {
    calls: [] as Array<{ method: string; actor: string; input: Record<string, any> }>,
    failNext: null as Error | null,
    async getTest(ctx: any, input: Record<string, any>) {
      catalog.calls.push({ method: 'getTest', actor: ctx.actor.type, input: structuredClone(input) });
      if (catalog.failNext) { const e = catalog.failNext; catalog.failNext = null; throw e; }
      const d = defs[input['testId']]; if (!d || d.kind !== 'test') throw new LimsError('common.not_found');
      if (input['requireActive'] && !d.isActive) throw new LimsError('catalog.test_inactive');
      return { id: input['testId'], code: d.code, name: d.name, isActive: d.isActive, revision: 1 };
    },
    async getPanel(ctx: any, input: Record<string, any>) {
      catalog.calls.push({ method: 'getPanel', actor: ctx.actor.type, input: structuredClone(input) });
      if (catalog.failNext) { const e = catalog.failNext; catalog.failNext = null; throw e; }
      const d = defs[input['panelId']]; if (!d || d.kind !== 'panel') throw new LimsError('common.not_found');
      if (input['requireActive'] && !d.isActive) throw new LimsError('catalog.test_inactive');
      return { id: input['panelId'], code: d.code, name: d.name, panelKind: 'package', members: [], isActive: d.isActive, revision: 1, ...(d.sexRestriction ? { sexRestriction: d.sexRestriction } : {}) };
    },
    async priceFor(ctx: any, input: Record<string, any>) {
      catalog.calls.push({ method: 'priceFor', actor: ctx.actor.type, input: structuredClone(input) });
      if (catalog.failNext) { const e = catalog.failNext; catalog.failNext = null; throw e; }
      const d = defs[input['orderableId']]; if (!d) throw new LimsError('common.not_found');
      if (d.priceError) throw d.priceError;
      if (d.paisa == null) throw new LimsError('catalog.no_price');
      return { orderableId: input['orderableId'], priceListId: PL, priceListVersion: d.listVersion ?? 1, source: 'tenant_default', unitPrice: { amountPaisa: d.paisa, currency: 'NPR' }, tax: { vat: 'exempt' } };
    },
  };
  const ports = { IdentityPort: identity, CatalogPort: catalog };

  // ---- seeding -------------------------------------------------------------------------------------------------------------------------------------------
  const item = (orderableId: string, over: Row = {}): Row => {
    const d = defs[orderableId]!;
    const r: Row = { id: newId(), tenant_id: TENANT_A, orderable_id: orderableId, orderable_kind: d.kind, code: d.code, display_name: d.name, indicative_price_paisa: d.paisa ?? null,
      price_list_id: d.paisa != null ? PL : null, price_list_version: d.paisa != null ? (d.listVersion ?? 1) : null, sex_restriction: d.sexRestriction ?? null, booking_kinds: ['centre_visit'],
      sort_order: 100, catalog_revision: 1, synced_at: T0, version: 1, is_active: true, created_at: T0, created_by: SYSTEM_ACTOR, updated_at: T0, updated_by: SYSTEM_ACTOR, ...over };
    t['items']!.push(r); return r;
  };
  /** Mutate the synthetic C3 catalogue (what the NEXT sync will see). */
  const setCatalog = (id: string, patch: Partial<Def> & { paisa?: number | undefined }) => { Object.assign(defs[id]!, patch); if ('paisa' in patch && patch.paisa === undefined) delete defs[id]!.paisa; };

  // ---- contexts ------------------------------------------------------------------------------------------------------------------------------------------
  const jobCtx = (over: Row = {}) => {
    const ref = { current: null as any };
    const ctx: any = { tenantId: TENANT_A, actor: { type: 'system', id: SYSTEM_ACTOR }, requestId: ID(0xe1), jobId: '1', attempt: 1, maxAttempts: 5, now, ports,
      log: { info() {}, warn() {}, error() {} }, audit: { access: async () => {}, event: async () => {} }, events: { publish: async () => {} }, ...over };
    ctx.tx = tx(ref); ref.current = ctx; ctx.db = { tx: async (fn: any) => fn(ctx) }; return ctx;
  };
  const staffCtx = (over: Row = {}) => jobCtx({ actor: { type: 'user', id: ID(0x7a1) }, ...over });

  const snapshot = () => structuredClone({ items: t['items'], jobs: t['jobs'] });
  /** Run like the queue does: one transaction; DB state rolls back when the task throws. */
  async function run(fn: (payload: any, ctx: any) => Promise<unknown>, payload: unknown, over: Row = {}) {
    const snap = snapshot(); const ctx = jobCtx(over);
    try { return await fn(payload, ctx); } catch (e) { t['items'] = snap.items!; t['jobs'] = snap.jobs!; throw e; }
  }

  return {
    t, stmts, now, advance: (ms: number) => { clock.t += ms; }, ports, identity, catalog, jobCtx, staffCtx, run, item, setCatalog, newId,
    get: (orderableId: string, tenant = TENANT_A) => t['items']!.find((r) => r['orderable_id'] === orderableId && r['tenant_id'] === tenant)!,
    jobs: (identifier?: string) => t['jobs']!.filter((j) => !identifier || j['identifier'] === identifier),
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(verbOf(s.text))),
    itemStmts: () => stmts.filter((s) => /engagement\.bookable_items/i.test(s.text)),
  };
}
export type BookableWorld = ReturnType<typeof makeBookableWorld>;
