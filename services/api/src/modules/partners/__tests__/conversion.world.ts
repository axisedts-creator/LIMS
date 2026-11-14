// C13 T10 test world: the T09 in-memory SQL world (same single-table fake SQL subset, see manifest-drafting.world.ts) plus
//   - partners.order_tracking (INSERT [ON CONFLICT ...] / SELECT; NOT NULLs, status CHECK, PK + line UNIQUE, FKs of 05-SCHEMA §order_tracking enforced),
//   - a marker table `fake_c4.markers` (INSERT INTO fake_c4.markers (id) VALUES ($1)): stands for "whatever C4 wrote before it threw" (patient row, booking link, consent rows), P-44,
//   - REAL savepoint semantics in ctx.db.tx (snapshot of every table on entry, restore when the callback throws, then rethrow) and whole-transaction rollback in runJob (a throwing job commits nothing),
//   - RLS stand-in for staff: statements on manifests / manifest_lines get `receiving_centre_id = ANY($n)` injected (centre list of the staff scope; 'all' = all centres) - the handlers write unqualified SQL, as under real RLS,
//   - staff ctx (actor type 'user', IdentityPort.assertRole that records every requirement and refuses a centre outside the scope), job ctx (system actor, ctx.ports.FrontdeskPort).
// NOT a test file. Synthetic data only.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createFakeFrontdeskPort } from '../../../../../../packages/fakes/src/FrontdeskPort.fake.js';
import { LimsError } from '../../../core/errors.js';
import { CE, id, makeCtx9, makeWorld9, OR, releaseLocks, T_A, type Over9, type Row, type World } from './manifest-lifecycle.world.js';

export * from './manifest-lifecycle.world.js';

export const SYS = id(80);          // partners system actor (worker)
export const PT = id(81);           // existing C4 patient picked by staff (retry with patient_id)
export const DOC = { x1: id(82), x2: id(83) };   // catalog doctors (mapped referrers)
export const CP = { x: id(30), y: id(31) };       // credit parties of partner X / Y (world seed)
export const STAFF_ID = id(3);
export const NOT_RECEIVED_REASONS = ['sample_missing', 'label_unreadable', 'wrong_container', 'leaked_or_broken', 'test_not_available', 'other'];

export type World10 = World & { tracking: Row[]; markers: Row[] };
export type ActorType = 'partner' | 'user' | 'system';
/** actor type of the statement in flight (propagates across the fake's awaits): guard_partner_columns acts for partner actors ONLY (05-SCHEMA.md:1078-1080, 08 A19 D-103; arbiter ruling C13.T10). */
const actorOf = new AsyncLocalStorage<ActorType>();

// ---------------------------------------------------------------------------------------------------- small SQL helpers (same grammar as the T08 world)
function balancedEnd(s: string, open: number): number {
  let depth = 0, q = false;
  for (let i = open; i < s.length; i++) { const c = s[i]; if (c === "'") q = !q; if (q) continue; if (c === '(') depth++; if (c === ')' && --depth === 0) return i; }
  throw new Error(`unbalanced parens in: ${s}`);
}
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (const c of s) { if (c === "'") q = !q; if (!q && c === '(') depth++; if (!q && c === ')') depth--; if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const pgErr = (code: string, constraint: string, message: string) => Object.assign(new Error(message), { code, constraint, detail: message });

export function makeWorld10(): World10 {
  const w = Object.assign(makeWorld9(), { tracking: [] as Row[], markers: [] as Row[] });
  const guard = w.guard.bind(w);
  w.guard = (table, cols, values) => { const a = actorOf.getStore(); if (a === 'user' || a === 'system') return; guard(table, cols, values); };
  const base = w.tables.bind(w);
  w.tables = () => {
    const t = base();
    const reasons = t['partners.g_cs_reasons'] as Row[];
    if (!reasons.some((r) => r['set_name'] === 'line_not_received_reasons'))
      NOT_RECEIVED_REASONS.forEach((code, i) => reasons.push({ set_name: 'line_not_received_reasons', code, requires_text: false, is_active: true, sort_order: i + 1 }));
    return { ...t, 'partners.order_tracking': w.tracking };
  };
  return w;
}

// ---------------------------------------------------------------------------------------------------- savepoints / rollback
const tablesOf = (w: World10): Row[][] => [w.manifests, w.lines, w.counters, w.referrers, w.tracking, w.markers, w.jobs as Row[]];
export type Snap = Array<Array<[Row, Row]>>;
export const snap = (w: World10): Snap => tablesOf(w).map((t) => t.map((r) => [r, structuredClone(r)] as [Row, Row]));
export function restore(w: World10, s: Snap): void {
  tablesOf(w).forEach((t, i) => { t.length = 0; for (const [ref, copy] of s[i]!) { for (const k of Object.keys(ref)) delete ref[k]; Object.assign(ref, structuredClone(copy)); t.push(ref); } });
}

// ---------------------------------------------------------------------------------------------------- tx wrapper (RLS stand-in, order_tracking, markers)
function scope(text: string, vals: unknown[], centres: string[] | 'all'): [string, unknown[]] {
  if (centres === 'all') return [text, vals];
  if (!/(\bFROM|^\s*UPDATE|^\s*DELETE\s+FROM)\s+partners\.(manifests|manifest_lines)\b/i.test(text)) return [text, vals];
  const pred = `receiving_centre_id = ANY($${vals.length + 1})`;
  const wi = text.search(/\bWHERE\b/i);
  const tail = (from: number) => { const m = /\s+(ORDER\s+BY|LIMIT|FOR\s+UPDATE|RETURNING)\b/i.exec(text.slice(from)); return m ? from + m.index : text.length; };
  if (wi < 0) { const t = tail(0); return [`${text.slice(0, t)} WHERE ${pred}${text.slice(t)}`, [...vals, centres]]; }
  const t = tail(wi);
  return [`${text.slice(0, wi + 5)} (${text.slice(wi + 5, t)}) AND ${pred}${text.slice(t)}`, [...vals, centres]];
}

async function trackingQuery(w: World10, text: string, vals: unknown[], centres: string[] | 'all'): Promise<{ rows: Row[]; rowCount: number }> {
  await Promise.resolve(); w.log.push({ text, values: [...vals] });
  let m: RegExpExecArray | null;
  if ((m = /^\s*INSERT\s+INTO\s+partners\.order_tracking\s*\(([^)]*)\)\s*VALUES\s*\(/i.exec(text))) {
    const cols = splitTop(m[1]!); const open = m[0].length - 1; const exprs = splitTop(text.slice(open + 1, balancedEnd(text, open)));
    if (cols.length !== exprs.length) throw new Error('fake SQL: column/value count mismatch');
    const given: Row = {}; cols.forEach((c, i) => { const v = w.ev(exprs[i]!, vals); given[c] = /_at$/.test(c) && typeof v === 'string' ? new Date(v) : v; });
    const row: Row = { registration_no: null, cancelled_at: null, report_count: 0, stored_order_status: null, reconciled_at: null, version: 1, created_at: new Date(w.now), updated_at: new Date(w.now), ...given };
    for (const c of Object.keys(row)) if (!['tenant_id', 'order_id', 'partner_id', 'line_id', 'manifest_id', 'receiving_centre_id', 'registration_no', 'tracking_status', 'registered_at', 'last_event_at', 'cancelled_at', 'report_count',
      'stored_order_status', 'reconciled_at', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'].includes(c)) throw pgErr('42703', c, `column ${c} does not exist`);
    for (const c of ['tenant_id', 'order_id', 'partner_id', 'line_id', 'manifest_id', 'receiving_centre_id', 'tracking_status', 'registered_at', 'last_event_at', 'created_by', 'updated_by']) if (row[c] == null) throw pgErr('23502', c, `order_tracking: ${c} null`);
    if (!['registered', 'in_transit', 'in_lab', 'action_needed', 'partially_reported', 'reported', 'cancelled'].includes(row['tracking_status'])) throw pgErr('23514', 'order_tracking__status__ck', 'status');
    if (row['registration_no'] != null && String(row['registration_no']).length > 40) throw pgErr('23514', 'order_tracking__regno__ck', 'registration_no');
    const line = w.lines.find((l) => l['tenant_id'] === row['tenant_id'] && l['id'] === row['line_id']);
    if (!line) throw pgErr('23503', 'order_tracking__line__fk', 'line fk');
    if (!w.manifests.some((x) => x['tenant_id'] === row['tenant_id'] && x['id'] === row['manifest_id'])) throw pgErr('23503', 'order_tracking__manifest__fk', 'manifest fk');
    if (!w.partners.some((x) => x['tenant_id'] === row['tenant_id'] && x['id'] === row['partner_id'])) throw pgErr('23503', 'order_tracking__partner__fk', 'partner fk');
    const dup = w.tracking.find((t) => t['tenant_id'] === row['tenant_id'] && (t['order_id'] === row['order_id'] || t['line_id'] === row['line_id']));
    if (dup) { if (/ON\s+CONFLICT/i.test(text)) return { rows: [], rowCount: 0 }; throw pgErr('23505', 'order_tracking__pk', 'duplicate order_tracking'); }
    w.tracking.push(row); return { rows: [{ ...row }], rowCount: 1 };
  }
  if (/^\s*SELECT\b/i.test(text)) {
    const hit = w.where(w.tracking, text, vals).filter((r) => centres === 'all' || centres.includes(r['receiving_centre_id']));
    return { rows: hit.map((r) => ({ ...r })), rowCount: hit.length };
  }
  throw new Error(`fake SQL: unsupported order_tracking statement: ${text}`);
}

export function wrapTx(w: World10, centres: string[] | 'all' = 'all', actorType: ActorType = 'partner') {
  const inner = w.newTx();
  const tx: any = Object.create(inner);
  tx.inner = inner;
  // SQL savepoints (C13.T10 ruling, 08 P-44): SAVEPOINT n pushes a snapshot, ROLLBACK TO n restores it and keeps the savepoint, RELEASE n pops it.
  const sps: Array<[string, Snap]> = [];
  tx.query = async (text: string, vals: unknown[] = []) => {
    let sp: RegExpExecArray | null;
    if ((sp = /^\s*(SAVEPOINT|ROLLBACK\s+TO(?:\s+SAVEPOINT)?|RELEASE(?:\s+SAVEPOINT)?)\s+("?[A-Za-z_][\w]*"?)\s*;?\s*$/i.exec(text))) {
      await Promise.resolve();
      const name = sp[2]!.replace(/"/g, '').toLowerCase(); const verb = sp[1]!.toUpperCase();
      if (verb === 'SAVEPOINT') { sps.push([name, snap(w)]); return { rows: [], rowCount: 0 }; }
      const at = sps.map((s) => s[0]).lastIndexOf(name);
      if (at < 0) throw pgErr('3B001', name, `savepoint "${name}" does not exist`);
      if (verb.startsWith('ROLLBACK')) { restore(w, sps[at]![1]); sps.length = at + 1; } else sps.length = at;
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*INSERT\s+INTO\s+fake_c4\.markers\b/i.test(text)) { await Promise.resolve(); w.markers.push({ id: vals[0] }); return { rows: [], rowCount: 1 }; }
    if (/\bpartners\.order_tracking\b/i.test(text)) return trackingQuery(w, text, vals, centres);
    const [t2, v2] = scope(text, vals, centres);
    return actorOf.run(actorType, () => inner.query(t2, v2));
  };
  return tx;
}
/** the fake "transaction" ends when the handler settles. */
export const release = (ctx: { tx: any }) => releaseLocks(ctx.tx.inner ?? ctx.tx);

// ---------------------------------------------------------------------------------------------------- FrontdeskPort fake (packages/fakes) + marker-writing wrapper
export function makeFrontdesk(over: { orderables?: Array<Record<string, unknown>>; patients?: Array<Record<string, unknown>> } = {}) {
  const testIds = (n: number) => [id(9000 + n)];
  const orderable = (oid: string, kind: 'test' | 'panel', n: number, extra: Record<string, unknown> = {}) => ({ id: oid, tenantId: T_A, kind, testIds: testIds(n), isActive: true, ...extra });
  return createFakeFrontdeskPort({
    seed: 7,
    fixtures: {
      orderables: over.orderables ?? [orderable(OR.glu, 'test', 1), orderable(OR.cbc, 'panel', 2), orderable(OR.tsh, 'test', 3), orderable(OR.a1c, 'test', 4)],
      patients: over.patients ?? [{ id: PT, tenantId: T_A, patientCode: 'P-SYN-0001', fullName: 'Synthetic Existing Patient', sex: 'female', birthOn: '1988-02-02', consents: { sms: true, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'v1' }, status: 'active' }],
    } as any,
  }) as any;
}
export type Frontdesk = ReturnType<typeof makeFrontdesk>;

/** Marker first (what C4 wrote before it threw), then the real fake call; records the savepoint depth at call time. */
export function markerPort(fd: Frontdesk, depths: number[] = []) {
  return {
    async createOrderFromBooking(ctx: any, input: any) {
      depths.push(ctx.__sp?.n ?? -1);
      await ctx.tx.query('INSERT INTO fake_c4.markers (id) VALUES ($1)', [`marker:${input?.sourceRefId}`]);
      return fd.createOrderFromBooking(ctx, input);
    },
  };
}

// ---------------------------------------------------------------------------------------------------- ctx builders
export interface StaffOver extends Over9 { centres?: string[] | 'all'; staffPerms?: string[] }
export function makeStaffCtx(w: World10, over: StaffOver = {}) {
  const centres = over.centres ?? [CE.a1]; const perms = over.staffPerms ?? ['partners.manifest.receive'];
  const r = makeCtx9(w, { ...over, who: 'staff', perms });
  const roleCalls: Array<{ permission: string; centreId?: string; branchId?: string }> = [];
  r.ctx.tx = wrapTx(w, centres, 'user');
  r.ctx.ports = { IdentityPort: { async assertRole(_c: unknown, req: { permission: string; centreId?: string; branchId?: string }) {
    roleCalls.push({ ...req });
    if (!perms.includes(req.permission)) throw new LimsError('auth.forbidden');
    if (req.centreId && centres !== 'all' && !centres.includes(req.centreId)) throw new LimsError('auth.forbidden');
  } } };
  return { ...r, roleCalls };
}
/** partner-side actor on the same world (probes: a partner user must not reach the staff operations). */
export function makePartnerCtx(w: World10, who: 'x1' | 'x2' | 'y1' = 'x1') {
  const r = makeCtx9(w, { who });
  r.ctx.tx = wrapTx(w, 'all', 'partner');
  return r;
}

export interface JobOver { port?: any; tenant?: string; attempt?: number }
export function makeJobCtx(w: World10, over: JobOver = {}) {
  const logs: string[] = []; const sp = { n: 0, opened: 0 };
  const sink = (x: unknown, m?: unknown) => logs.push(JSON.stringify([x, m]));
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child: () => log };
  const metrics: Array<{ name: string; labels?: unknown }> = [];
  const ctx: any = {
    tenantId: over.tenant ?? T_A, actor: { type: 'system', id: SYS }, requestId: id(97), tx: wrapTx(w, 'all', 'system'), attempt: over.attempt ?? 1, maxAttempts: 10, jobId: '1', __sp: sp,
    now: () => w.now, isNewer: (last: number | undefined, seq: number) => last === undefined || seq > last,
    events: {}, core: {}, audit: { access: async () => undefined }, storage: {}, files: {}, log,
    metrics: { inc: (name: string, labels?: unknown) => metrics.push({ name, labels }), set() {}, observe() {} },
    ports: { FrontdeskPort: over.port },
  };
  ctx.db = { async tx(fn: (c: unknown) => Promise<unknown>) {
    const s = snap(w); sp.n++; sp.opened++;
    try { return await fn(ctx); } catch (e) { restore(w, s); throw e; } finally { sp.n--; }
  } };
  return { ctx, logs, sp, metrics };
}

/** One delivery of a task = one transaction: a throw rolls EVERYTHING back (nothing committed); success commits. Returns the thrown error instead of throwing. */
export async function runJob(w: World10, handler: (p: any, c: any) => Promise<void>, payload: unknown, over: JobOver = {}) {
  const jc = makeJobCtx(w, over); const s = snap(w); let threw: any;
  try { await handler(payload, jc.ctx); } catch (e) { threw = e; restore(w, s); } finally { release(jc.ctx); }
  return { threw, ...jc };
}
