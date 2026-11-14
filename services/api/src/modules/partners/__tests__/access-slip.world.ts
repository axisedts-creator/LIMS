// C13 T14 test fixture (tester-owned, not a test file): world for the patient access slip (08 A2.1; R4-R6 + worker tasks partners.issue_access_slip / partners.purge_access_slips).
// Builds on the T13 world (tracking-api.world.ts: seed13 + request ctx emulation) and adds
//   - partners.access_slips (05-SCHEMA §3.7a): NOT NULLs, state CHECK, "NOT NULL iff state" column rules, file_path pattern, FKs to order_reports / order_tracking / partner_users;
//     guard emulation in `slipTx(w, actor)`: partner actors may only INSERT state `requested` and never UPDATE/DELETE; nobody DELETEs; UPDATE only along requested->issued|failed, issued->expired (partners.guard_access_slip_update),
//   - an in-memory `partners-slips` storage fake (put/read/delete with call recording and failure injection),
//   - port fakes that RECORD (ReportingPort.issuePortalLink, RenderPort.renderPdf) with the planted secret URL (marker SLIPTOKEN) that must never reach a column, job payload, log, SQL value, response or audit row,
//   - the request ctx for R4-R6 (every port other than IdentityPort is a tripwire: any access is recorded in `denied` and throws) and the job ctx for the worker tasks.
// Same fake-SQL subset as the T13 world: single-table statements with bound $n values, no joins / sub-selects. The world runs with rls=false: the handlers must scope by tenant_id AND partner_id themselves.
// All data synthetic.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { createDownload } from '../../../core/storage/download.js';
import { id, makeWorld, T_A, T_B, type Def, type Row, type World } from './projection.world.js';
import { makeCtx, NOW13, ORD, RPT, seed13, U, type Opts, type Who } from './tracking-api.world.js';
import { TRACKING_DEFS } from './tracking.world.js';

export * from './tracking-api.world.js';

// ------------------------------------------------------------------ planted secrets
export const TOKEN = 'SLIPTOKEN-9d41c7e05b3a';
export const MARKERS = [TOKEN, 'portal.invalid'];
export const urlOf = (n: number) => `https://portal.invalid/r/${TOKEN}-${n}`;
export const BUCKET = 'partners-slips';
export const SYS = id(80);
export const SL = {
  req: id(901), issued: id(902), failed: id(903), expired: id(904), y: id(905), b: id(906), issuedY: id(907), issuedB: id(908), newer: id(909),
  old1: id(911), old2: id(912), fresh: id(913), oldB: id(914), requestedOld: id(915), oldY: id(916),
};
export const LINK = { issued: id(951), old1: id(952), old2: id(953), fresh: id(954), oldB: id(955), expired: id(956), issuedY: id(957), issuedB: id(958), oldY: id(959) };
export const RPT_SUP = id(647); // a report whose only version is superseded
export const EXPIRES = '2026-12-13T06:00:00.000Z'; // what the port returns: 11:45 in Asia/Kathmandu (also in a 12 h clock)

// ------------------------------------------------------------------ partners.access_slips
const pgErr = (code: string, constraint: string, message: string) => Object.assign(new Error(message), { code, constraint, detail: message });
const HEX64 = /^[0-9a-f]{64}$/;
const FAIL_CODE = /^[a-z_]+\.[a-z_]+$/;

/** the table's CHECK constraints (05-SCHEMA §3.7a); null = ok */
export function slipInvariant(r: Row): string | null {
  if (!['requested', 'issued', 'failed', 'expired'].includes(r['state'])) return 'access_slips__state__ck';
  if (!(Number.isInteger(r['version_no']) && r['version_no'] >= 1)) return 'access_slips__version_no__ck';
  const linked = r['state'] === 'issued' || r['state'] === 'expired';
  if (linked !== (r['link_id'] != null) || linked !== (r['link_expires_at'] != null)) return 'access_slips__link__ck';
  const filed = r['state'] === 'issued';
  if (filed !== (r['file_path'] != null) || filed !== (r['file_sha256'] != null) || filed !== (r['file_byte_size'] != null)) return 'access_slips__file__ck';
  if (filed) {
    const want = new RegExp(`^${r['tenant_id']}/access-slips/\\d{4}/\\d{2}/${r['id']}\\.pdf$`);
    if (!want.test(r['file_path']) || r['file_path'].length > 200) return 'access_slips__file_path__ck';
    if (!HEX64.test(r['file_sha256'])) return 'access_slips__file_sha256__ck';
    if (!(Number.isInteger(r['file_byte_size']) && r['file_byte_size'] >= 1 && r['file_byte_size'] <= 10_485_760)) return 'access_slips__file_byte_size__ck';
    if (r['issued_at'] == null) return 'access_slips__issued_at__ck';
  }
  if ((r['state'] === 'failed') !== (r['failure_code'] != null)) return 'access_slips__failure__ck';
  if (r['failure_code'] != null && (!FAIL_CODE.test(r['failure_code']) || r['failure_code'].length > 64)) return 'access_slips__failure_code__ck';
  if ((r['state'] === 'expired') !== (r['expired_at'] != null)) return 'access_slips__expired_at__ck';
  return null;
}

const nulls = () => null;
const AS: Def = {
  pk: ['tenant_id', 'id'], fk: true, bigint: [],
  notNull: ['tenant_id', 'id', 'partner_id', 'partner_user_id', 'report_id', 'version_no', 'order_id', 'state', 'version', 'created_by', 'updated_by'],
  defaults: { state: () => 'requested', version: () => 1, created_at: () => new Date(NOW13), updated_at: () => new Date(NOW13), link_id: nulls, link_expires_at: nulls, file_path: nulls, file_sha256: nulls, file_byte_size: nulls, failure_code: nulls, issued_at: nulls, expired_at: nulls },
  check: slipInvariant,
  fkCheck: (r, t) => !t['partners.order_reports']!.some((x) => x['tenant_id'] === r['tenant_id'] && x['report_id'] === r['report_id'] && x['version_no'] === r['version_no'] && x['partner_id'] === r['partner_id']) ? 'access_slips__report__fk'
    : !t['partners.order_tracking']!.some((x) => x['tenant_id'] === r['tenant_id'] && x['order_id'] === r['order_id'] && x['partner_id'] === r['partner_id']) ? 'access_slips__order__fk'
    : !t['partners.partner_users']!.some((x) => x['tenant_id'] === r['tenant_id'] && x['id'] === r['partner_user_id'] && x['partner_id'] === r['partner_id']) ? 'access_slips__user__fk' : null,
};
export const makeWorld14 = (): World => makeWorld({ defs: { ...TRACKING_DEFS, 'partners.access_slips': AS }, tables: ['partners.manifests', 'partners.partner_referrers'] });

const ALLOWED: Record<string, string[]> = { requested: ['issued', 'failed'], issued: ['expired'] };
export type Actor = 'partner' | 'user' | 'system';
/** the statement runner of one request/job: RLS WITH CHECK + guard_access_slip_update + the missing DELETE privilege, then the CHECK constraints on every touched row. */
export function slipTx(w: World, actor: Actor) {
  return {
    async query(text: string, vals: unknown[] = []) {
      const s = text.trim().replace(/\s+/g, ' ');
      const on = /\bpartners\.access_slips\b/i.test(s);
      if (on && /^DELETE\b/i.test(s)) throw pgErr('42501', 'access_slips__delete', 'permission denied for table access_slips (DELETE)');
      if (on && actor !== 'system' && /^UPDATE\b/i.test(s)) throw pgErr('42501', 'access_slips__guard', 'partners.guard_access_slip_update: every UPDATE requires the system actor');
      const before: Row[] | null = on ? structuredClone(w.t['partners.access_slips']!) : null;
      const res = await w.tx.query(text, vals);
      if (before) {
        const bad = (c: string, m: string) => { w.t['partners.access_slips'] = before; return pgErr('23514', c, m); };
        for (const r of w.t['partners.access_slips']!) {
          const was = before.find((b) => b['tenant_id'] === r['tenant_id'] && b['id'] === r['id']);
          if (!was) { if (actor === 'partner' && r['state'] !== 'requested') throw bad('access_slips__rls_with_check', `partner actor inserted state ${r['state']}`); }
          else if (was['state'] !== r['state'] && !(ALLOWED[was['state']] ?? []).includes(r['state'])) throw bad('access_slips__transition', `partners.guard_access_slip_update: ${was['state']} -> ${r['state']}`);
          const ck = slipInvariant(r); if (ck) throw bad(ck, `check ${ck}`);
        }
      }
      return res;
    },
  };
}

// ------------------------------------------------------------------ storage fake (bucket partners-slips)
export function makeStorage() {
  const objects = new Map<string, Uint8Array>();
  const calls: Array<{ op: 'put' | 'read' | 'delete'; bucket: string; path: string; opts?: Row }> = [];
  const fail: { put?: Error; read?: Error; delete?: (path: string) => Error | undefined } = {};
  const key = (b: string, p: string) => `${b}|${p}`;
  return {
    objects, calls, fail,
    async put(bucket: string, path: string, bytes: Uint8Array, opts: Row = {}) {
      await Promise.resolve(); calls.push({ op: 'put', bucket, path, opts });
      if (fail.put) throw fail.put;
      if (opts['ifAbsent'] && objects.has(key(bucket, path))) throw new Error('storage: object exists');
      objects.set(key(bucket, path), Uint8Array.from(bytes));
      return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
    },
    async read(bucket: string, path: string) {
      await Promise.resolve(); calls.push({ op: 'read', bucket, path });
      if (fail.read) throw fail.read;
      const o = objects.get(key(bucket, path)); if (!o) throw new LimsError('common.not_found');
      return Uint8Array.from(o);
    },
    async delete(bucket: string, path: string) {
      await Promise.resolve(); calls.push({ op: 'delete', bucket, path });
      const e = fail.delete?.(path); if (e) throw e;
      if (!objects.delete(key(bucket, path))) throw new LimsError('common.not_found');
    },
    has: (path: string, bucket = BUCKET) => objects.has(key(bucket, path)),
    get: (path: string, bucket = BUCKET) => objects.get(key(bucket, path)),
    set: (path: string, bytes: Uint8Array, bucket = BUCKET) => { objects.set(key(bucket, path), bytes); },
  };
}
export type Storage = ReturnType<typeof makeStorage>;

// ------------------------------------------------------------------ seed
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** a slip PDF as C6 would draw it: the link is inside (QR + text), so the BYTES legitimately contain the url. */
export const slipPdf = (slipId: string) => Buffer.from(`%PDF-1.7\n% synthetic access slip ${slipId}\n${urlOf(0)}\n%%EOF\n`);
export const slipPath = (slipId: string, tenant = T_A, yyyy = '2026', mm = '11') => `${tenant}/access-slips/${yyyy}/${mm}/${slipId}.pdf`;
const at = (s: string) => new Date(s);

/** a requested slip row (partner X, report RPT.b v1 on ORD.lab, requested by adminX) with overrides */
export function slipRow(o: Row = {}): Row {
  return { tenant_id: T_A, id: SL.req, partner_id: id(20), partner_user_id: U.adminX, report_id: RPT.b, version_no: 1, order_id: ORD.lab, state: 'requested', version: 1,
    link_id: null, link_expires_at: null, file_path: null, file_sha256: null, file_byte_size: null, failure_code: null, issued_at: null, expired_at: null,
    created_at: at('2026-11-13T05:59:00Z'), created_by: U.adminX, updated_at: at('2026-11-13T05:59:00Z'), updated_by: U.adminX, ...o };
}
/** an `issued` slip row whose PDF is in the storage fake at the registered path */
export function issuedSlip(w: World, st: Storage | undefined, o: Row): Row {
  const sid = o['id'] as string; const tenant = (o['tenant_id'] as string | undefined) ?? T_A;
  const bytes = slipPdf(sid); const path = slipPath(sid, tenant);
  const row = slipRow({ state: 'issued', link_id: LINK.issued, link_expires_at: at('2026-12-10T06:00:00Z'), file_path: path, file_sha256: sha256(bytes), file_byte_size: bytes.length, issued_at: at('2026-11-13T05:59:30Z'), ...o });
  if (slipInvariant(row)) throw new Error(`fixture: ${slipInvariant(row)}`);
  w.t['partners.access_slips']!.push(row); st?.set(String(row['file_path']), bytes);
  return row;
}

/**
 * Tenant A: partner X (adminX, memberX), partner Y (adminY), suspended partner Z (adminZ); tenant B partner B (adminB). Feature flag ON unless `enabled: false` (`null` = no settings row).
 * Reports (T13 seed): RPT.b v1 valid on ORD.lab, RPT.a v1 superseded + v2 valid on ORD.rep, RPT.y valid (partner Y), RPT.bb valid (tenant B); RPT_SUP: only a superseded version.
 * Slips: SL.req requested (X), SL.issued issued (X, object stored), SL.failed failed (X), SL.expired expired (X), SL.y requested (Y), SL.issuedY issued (Y), SL.b requested (tenant B), SL.issuedB issued (tenant B).
 */
export function seed14(w: World, st?: Storage, o: { enabled?: boolean | null } = {}) {
  seed13(w);
  const T = w.t; const enabled = o.enabled === undefined ? true : o.enabled;
  if (enabled !== null) T['partners.settings']!.push({ tenant_id: T_A, access_slip_enabled: enabled, include_default_price_list: true, report_download_daily_cap_per_user: 500 });
  T['partners.order_reports']!.push({ ...T['partners.order_reports']!.find((r) => r['report_id'] === RPT.b)!, report_id: RPT_SUP, version_no: 1, status: 'superseded' });
  const X = id(20), Y = id(21), B = id(23);
  T['partners.access_slips']!.push(
    slipRow({ id: SL.req, partner_id: X }),
    slipRow({ id: SL.failed, partner_id: X, state: 'failed', failure_code: 'reporting.report_superseded' }),
    slipRow({ id: SL.expired, partner_id: X, state: 'expired', link_id: LINK.expired, link_expires_at: at('2026-11-01T06:00:00Z'), expired_at: at('2026-11-02T21:05:00Z') }),
    slipRow({ id: SL.y, partner_id: Y, partner_user_id: U.adminY, report_id: RPT.y, order_id: ORD.y }),
    slipRow({ id: SL.b, tenant_id: T_B, partner_id: B, partner_user_id: U.adminB, report_id: RPT.bb, order_id: ORD.b, created_by: U.adminB, updated_by: U.adminB }));
  issuedSlip(w, st, { id: SL.issued, partner_id: X });
  issuedSlip(w, st, { id: SL.issuedY, partner_id: Y, partner_user_id: U.adminY, report_id: RPT.y, order_id: ORD.y, link_id: LINK.issuedY });
  issuedSlip(w, st, { id: SL.issuedB, tenant_id: T_B, partner_id: B, partner_user_id: U.adminB, report_id: RPT.bb, order_id: ORD.b, link_id: LINK.issuedB, created_by: U.adminB, updated_by: U.adminB });
}
export const slips = (w: World) => w.t['partners.access_slips']!;
export const slipById = (w: World, sid: string, tenant = T_A) => slips(w).find((r) => r['tenant_id'] === tenant && r['id'] === sid);

// ------------------------------------------------------------------ leak scanning
/** needles found anywhere in: every table, the job queue, every SQL text + bound value, the access log. */
export function worldLeaks(w: World, needles: string[] = MARKERS): string[] {
  const hay = JSON.stringify({ t: w.t, jobs: w.jobs, log: w.log, audit: w.audit }).toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
}
export const leaksIn = (x: unknown, needles: string[] = MARKERS): string[] => {
  const plain = x instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(x).map((k) => [k, (x as any)[k]])) : x;
  const hay = JSON.stringify(plain, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v)).toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
};

// ------------------------------------------------------------------ request ctx (R4-R6)
/** tripwire: any property access on a port other than IdentityPort is recorded and any call throws. */
function tripwire(name: string, calls: string[]) {
  return new Proxy({}, { get: (_t, m) => (..._a: unknown[]) => { calls.push(`${name}.${String(m)}`); throw new Error(`unexpected call ${name}.${String(m)}`); } });
}
export function makeSlipCtx(w: World, who: Who, handlers: Record<string, (req: any, ctx: any) => Promise<any>>, st: Storage = makeStorage(), o: Opts = {}) {
  const r = makeCtx(w, who, handlers, o);
  const denied: string[] = [];
  const base: Record<string, unknown> = { IdentityPort: (r.ctx.ports as any).IdentityPort };
  r.ctx.ports = new Proxy(base, { get: (t, p) => (p in t ? t[p as string] : (denied.push(`ports.${String(p)}`), tripwire(String(p), denied))) });
  r.ctx.tx = slipTx(w, (o.actorType ?? 'partner') as Actor);
  r.ctx.storage = st;
  r.ctx.download = createDownload({ storage: st as any, audit: r.ctx.audit });
  return { ...r, st, denied };
}

// ------------------------------------------------------------------ job ctx (worker tasks)
export interface JobOpts { tenant?: string; now?: string; attempt?: number; calendar?: string }
/** ReportingPort + RenderPort fakes that record every call. `issueErr` / `renderErr` are consumed once when set to a function, or thrown every time when an Error. */
export function makePorts(w: World) {
  const issue: Array<{ actorType: string; tenantId: string; input: any }> = [];
  const render: Array<{ actorType: string; tenantId: string; input: any }> = [];
  const idem = new Map<string, { fp: string; out: any }>();
  const ctl: { issueErr?: Error | (() => Error); renderErr?: Error | (() => Error); links: number; renders: number } = { links: 0, renders: 0 };
  const thrown = (e: Error | (() => Error)) => (typeof e === 'function' ? e() : e);
  const REQUIRED = ['tenantDisplayName', 'partnerName', 'patientDisplayName', 'orderRef', 'portalUrl', 'expiresAtLocal', 'issuedAtLocal'];
  const ReportingPort = {
    async issuePortalLink(c: any, input: any) {
      issue.push({ actorType: c.actor?.type, tenantId: c.tenantId, input: structuredClone(input) });
      if (c.actor?.type !== 'system' && c.actor?.type !== 'user') throw new LimsError('auth.forbidden');
      if (ctl.issueErr) { const e = ctl.issueErr; if (typeof e === 'function') ctl.issueErr = undefined; throw thrown(e); }
      const n = ++ctl.links;
      return { linkId: id(980 + n), url: urlOf(n), expiresAt: EXPIRES };
    },
  };
  const RenderPort = {
    async renderPdf(c: any, input: any) {
      render.push({ actorType: c.actor?.type, tenantId: c.tenantId, input: structuredClone(input) });
      if (c.actor?.type !== 'system') throw new LimsError('auth.forbidden');
      if (ctl.renderErr) { const e = ctl.renderErr; if (typeof e === 'function') ctl.renderErr = undefined; throw thrown(e); }
      if (input?.templateKey !== 'partners.access_slip') throw new LimsError('common.validation_failed');
      const data = input.data;
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey) throw new LimsError('common.validation_failed');
      if (!data || typeof data !== 'object' || REQUIRED.some((k) => data[k] == null)) throw new LimsError('reporting.template_invalid');
      const fp = JSON.stringify([input.templateKey, data]); const prev = idem.get(input.idempotencyKey);
      if (prev) { if (prev.fp !== fp) throw new LimsError('common.idempotency_key_reused'); return { ...prev.out }; }
      ctl.renders++;
      const bytes = Buffer.from(`%PDF-1.7\n% synthetic slip for ${data.orderRef}\n${data.portalUrl}\n%%EOF\n`);
      const out = { contentBase64: bytes.toString('base64'), sha256: sha256(bytes), byteSize: bytes.length, pageCount: 1 };
      idem.set(input.idempotencyKey, { fp, out }); return { ...out };
    },
  };
  void w;
  return { ReportingPort, RenderPort, issue, render, ctl };
}

export function makeSlipJob(w: World, st: Storage, ports: ReturnType<typeof makePorts>, over: JobOpts = {}) {
  const logs: string[] = [];
  const sink = (x: unknown, m?: unknown) => logs.push(JSON.stringify([x, m]));
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child: () => log };
  const metrics: Array<{ name: string; labels?: unknown }> = [];
  const settingsCalls: unknown[] = []; const tenantCalls: number[] = [];
  const ctx: any = {
    tenantId: over.tenant ?? T_A, actor: { type: 'system', id: SYS }, requestId: id(97), tx: slipTx(w, 'system'), attempt: over.attempt ?? 1, maxAttempts: 10, jobId: '1',
    now: () => over.now ?? NOW13, isNewer: () => true, events: {}, files: {}, audit: { access: async () => undefined }, log, storage: st,
    metrics: { inc: (name: string, labels?: unknown) => metrics.push({ name, labels }), set() {}, observe() {} },
    core: { tenant: async () => { tenantCalls.push(1); return { displayName: 'Synthetic Lab Kathmandu' }; } },
    ports: { ReportingPort: ports.ReportingPort, RenderPort: ports.RenderPort,
      IdentityPort: { async getTenantSettings(_c: unknown, input: { keys?: string[] }) {
        settingsCalls.push(input);
        if (!input?.keys?.length || input.keys.some((k) => !['timezone', 'calendarDisplay', 'reportLinkTtlDays', 'retentionYears'].includes(k))) throw new LimsError('auth.forbidden');
        return { timezone: 'Asia/Kathmandu', calendarDisplay: over.calendar ?? 'AD', reportLinkTtlDays: 30, retentionYears: 5 };
      } } },
  };
  ctx.db = { tx: async (fn: (c: unknown) => Promise<unknown>) => fn(ctx) };
  return { ctx, logs, metrics, settingsCalls, tenantCalls };
}

/** One delivery of a task = one transaction: a throw restores every table and the queue (the object storage is NOT transactional). Returns the thrown error instead of throwing. */
export async function runSlipJob(w: World, handler: (p: any, c: any) => Promise<unknown>, payload: unknown, st: Storage, ports: ReturnType<typeof makePorts>, over: JobOpts = {}) {
  const jc = makeSlipJob(w, st, ports, over); const snap = w.snapshot(); let threw: any;
  try { await handler(payload, jc.ctx); } catch (e) { threw = e; w.restore(snap); }
  return { threw, ...jc };
}
