// C16.T-R1 test world (NOT a test file): in-memory engagement schema + port fakes shared by the API handler tests and the worker task tests.
// The fake `tx.query` answers by statement TYPE + table (never by exact SQL), the same convention as settings.handlers.test.ts / queue.handlers.test.ts:
//   engagement.reminders, .settings, .accounts + .account_patient_links (join answered as one row per ACTIVE link), .notifications, .bookings, .cs_/g_cs_reminder_reasons,
//   and `app.enqueue_job($1 identifier, $2 payload, $3 job_key, ...)` (de-duplicated on identifier + job_key, like the real queue).
// RLS model: every row read/written is filtered to the SESSION tenant (ctx.tenantId). WHERE clauses are emulated from BOUND VALUES (row id, version number, 'scheduled').
// DB rules emulated like the 05-SCHEMA constraints/triggers: reminders__sent__ck ((status='sent') = (sent_at IS NOT NULL)), status machine scheduled -> {sent,suppressed,failed,cancelled}
// only, partial unique (tenant, kind, source_ref_id, source_ref_seq), notifications__dedupe__uq. Time = the fake clock (`world.now()`), never the real one.
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { LimsError } from '../../../core/errors.js';

export const TENANT_A: string = TENANTS.A;
export const TENANT_B: string = TENANTS.B;
export const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
export const PATIENT = ID(0x501), PATIENT_B = ID(0x5b1), ACCOUNT_1 = ID(0x601), ACCOUNT_2 = ID(0x602), SYSTEM_ACTOR = ID(0x7f1);
export const LAB_NAME = 'Synthetic Lab';
export const T0 = '2026-03-01T04:00:00.000Z';

type Row = Record<string, any>;
export interface Stmt { text: string; values: unknown[] }
const verbOf = (t: string) => /^\s*(select|insert|update|delete|with)\b/i.exec(t)?.[1]?.toLowerCase() ?? 'other';
const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });

export function makeWorld(opts: { remindersEnabled?: boolean } = {}) {
  const clock = { t: Date.parse(T0) };
  const now = () => new Date(clock.t).toISOString();
  const t: Record<string, Row[]> = { reminders: [], settings: [], accounts: [], links: [], notifications: [], bookings: [], jobs: [] };
  const stmts: Stmt[] = [];
  let seq = 0x9000;
  const newId = () => ID(++seq);
  t['settings']!.push({ id: newId(), tenant_id: TENANT_A, reminders_enabled: opts.remindersEnabled ?? true, auto_follow_up_reminders: false, booking_reminder_hours_before: 24, follow_up_reminder_lead_days: 3, version: 1 });
  const REASONS = ['follow_up_test', 'repeat_test', 'collect_report'];

  const refs = (text: string, values: unknown[]) => [...text.matchAll(/\$(\d+)/g)].map((m) => values[Number(m[1]) - 1]);
  const lit = (tok: string, values: unknown[]): unknown => {
    const p = /^\$(\d+)(::\w+)?$/.exec(tok); if (p) return values[Number(p[1]) - 1];
    if (/^'.*'$/.test(tok)) return tok.slice(1, -1);
    if (/^(now|clock_timestamp)\(\)$/i.test(tok) || /^transaction_timestamp\(\)$/i.test(tok)) return now();
    if (/^null$/i.test(tok)) return null; if (/^true$/i.test(tok)) return true; if (/^false$/i.test(tok)) return false;
    if (/^-?\d+$/.test(tok)) return Number(tok);
    return undefined;
  };
  const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const session = (ctx: any) => ctx.tenantId as string;

  function reminderCheck(r: Row) {
    if ((r['status'] === 'sent') !== (r['sent_at'] != null)) throw pgErr('23514', 'reminders__sent__ck');
    if (r['kind'] !== 'booking' && r['reason_code'] == null) throw pgErr('23514', 'reminders__reason__ck');
    if (r['failure_code'] != null && String(r['failure_code']).length > 64) throw pgErr('23514', 'reminders__failure__ck');
  }

  function exec(ctx: any, text: string, values: unknown[] = []): { rows: Row[]; rowCount: number } {
    stmts.push({ text, values });
    const sql = text.replace(/\s+/g, ' ').trim(); const verb = verbOf(sql); const tenant = session(ctx);
    const ok = (rows: Row[], rowCount = rows.length) => ({ rows, rowCount });

    if (/app\.enqueue_job/i.test(sql)) {
      let payload: any = values[1]; if (typeof payload === 'string') payload = JSON.parse(payload);
      const job = { identifier: String(values[0]), payload, jobKey: values[2], tenant };
      if (job.jobKey != null && t['jobs']!.some((j) => j['identifier'] === job.identifier && j['jobKey'] === job.jobKey)) return ok([{ enqueue_job: 1 }]);
      t['jobs']!.push(job); return ok([{ enqueue_job: 1 }]);
    }
    if (/engagement\.(g_)?cs_reminder_reasons/i.test(sql)) return ok(REASONS.map((code, i) => ({ code, display: code, sort_order: i, is_active: true })));
    if (/engagement\.settings/i.test(sql) && verb === 'select') return ok(t['settings']!.filter((r) => r['tenant_id'] === tenant).map((r) => ({ ...r })));
    if (/engagement\.bookings/i.test(sql) && verb === 'select') return ok(t['bookings']!.filter((r) => r['tenant_id'] === tenant && values.includes(r['id'])).map((r) => ({ ...r })));

    if (/engagement\.account_patient_links|engagement\.accounts/i.test(sql) && verb === 'select') {
      const links = t['links']!.filter((l) => l['tenant_id'] === tenant && l['status'] === 'active' && values.includes(l['patient_id']));
      const rows = links.flatMap((l) => {
        const a = t['accounts']!.find((x) => x['id'] === l['account_id'] && x['tenant_id'] === tenant); if (!a || a['status'] === 'deleted') return [];
        return [{ id: a['id'], account_id: a['id'], patient_id: l['patient_id'], link_id: l['id'], link_status: l['status'], account_status: a['status'], reminders_opt_out: a['reminders_opt_out'] }];
      });
      return ok(rows);
    }

    if (/engagement\.notifications/i.test(sql)) {
      if (verb === 'select') return ok(t['notifications']!.filter((n) => n['tenant_id'] === tenant).map((n) => ({ ...n })));
      if (verb === 'insert') {
        const m = /\(([^)]*)\)\s*(?:values|select)\s*\((.*?)\)\s*(?:on conflict|returning|$)/i.exec(sql); if (!m) throw new Error(`fake: cannot parse notifications INSERT: ${sql}`);
        const cols = m[1]!.split(',').map((c) => c.trim()); const toks = splitTop(m[2]!); const row: Row = { id: newId(), tenant_id: tenant, entity_seq: 0, read_at: null };
        cols.forEach((c, i) => { row[c] = lit(toks[i]!, values); });
        if (row['tenant_id'] == null) row['tenant_id'] = tenant;
        if (t['notifications']!.some((n) => n['tenant_id'] === row['tenant_id'] && n['account_id'] === row['account_id'] && n['kind'] === row['kind'] && (n['entity_id'] ?? null) === (row['entity_id'] ?? null) && (n['entity_seq'] ?? 0) === (row['entity_seq'] ?? 0))) {
          if (/on conflict/i.test(sql)) return ok([], 0); throw pgErr('23505', 'notifications__dedupe__uq');
        }
        t['notifications']!.push(row); return ok(/returning/i.test(sql) ? [{ ...row }] : [], 1);
      }
    }

    if (/engagement\.reminders/i.test(sql)) {
      const mine = () => t['reminders']!.filter((r) => r['tenant_id'] === tenant);
      if (verb === 'select') {
        if (/for update skip locked/i.test(sql) || /due_at\s*<=/i.test(sql)) {
          const bound = values.find((v) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)));
          const cutoff = bound instanceof Date ? bound.getTime() : bound ? Date.parse(bound as string) : clock.t;
          const lim = /limit\s+(\d+)/i.exec(sql)?.[1] ? Number(/limit\s+(\d+)/i.exec(sql)![1]) : (values.find((v) => v === 500) as number | undefined) ?? 1e9;
          return ok(mine().filter((r) => r['status'] === 'scheduled' && Date.parse(r['due_at']) <= cutoff).sort((a, b) => Date.parse(a['due_at']) - Date.parse(b['due_at']) || (a['id'] < b['id'] ? -1 : 1)).slice(0, lim).map((r) => ({ ...r })));
        }
        // Only `id = $n` / `patient_id = $n` refs are id filters: the tenant bind and the keyset-cursor id are NOT (REQ-SEC-024: repos bind tenant_id explicitly).
        const colEq = (col: string) => [...sql.matchAll(new RegExp(`(?<![\\w.])${col}\\s*=\\s*\\$(\\d+)`, 'gi'))].map((m) => values[Number(m[1]) - 1]);
        const ids = colEq('id'), pids = colEq('patient_id');
        let rows = mine(); if (ids.length) rows = rows.filter((r) => ids.includes(r['id'])); if (pids.length) rows = rows.filter((r) => pids.includes(r['patient_id']));
        const cur = /\(due_at,\s*id\)\s*>\s*\(\s*\$(\d+)(?:::\w+)?\s*,\s*\$(\d+)/i.exec(sql);
        if (cur) { const d = Date.parse(values[Number(cur[1]) - 1] as string), cid = values[Number(cur[2]) - 1] as string; rows = rows.filter((r) => Date.parse(r['due_at']) > d || (Date.parse(r['due_at']) === d && r['id'] > cid)); }
        const st = values.find((v) => typeof v === 'string' && ['scheduled', 'sent', 'suppressed', 'failed', 'cancelled'].includes(v)); if (st) rows = rows.filter((r) => r['status'] === st);
        return ok(rows.map((r) => ({ ...r })));
      }
      if (verb === 'insert') {
        const m = /\(([^)]*)\)\s*values\s*\((.*?)\)\s*(?:on conflict|returning|$)/i.exec(sql); if (!m) throw new Error(`fake: cannot parse reminders INSERT: ${sql}`);
        const cols = m[1]!.split(',').map((c) => c.trim()); const toks = splitTop(m[2]!);
        const row: Row = { id: newId(), tenant_id: tenant, status: 'scheduled', source_ref_id: null, source_ref_seq: 0, sent_at: null, delivery_id: null, failure_code: null, version: 1, is_active: true, reason_code: null };
        cols.forEach((c, i) => { row[c] = lit(toks[i]!, values); });
        if (row['source_ref_id'] != null && mine().some((r) => r['kind'] === row['kind'] && r['source_ref_id'] === row['source_ref_id'] && (r['source_ref_seq'] ?? 0) === (row['source_ref_seq'] ?? 0))) {
          if (/on conflict/i.test(sql)) return ok([], 0); throw pgErr('23505', 'reminders__tenant_id_source_ref__p_uq');
        }
        reminderCheck(row); t['reminders']!.push(row); return ok(/returning/i.test(sql) ? [{ ...row }] : [], 1);
      }
      if (verb === 'update') {
        const m = /set (.+?) where (.+?)(?: returning .*)?$/i.exec(sql); if (!m) throw new Error(`fake: cannot parse reminders UPDATE: ${sql}`);
        const setPart = m[1]!, where = m[2]!;
        const whereVals = refs(where, values);
        // T-B5: besides `id = $n`, a booking's reminders are addressed by `source_ref_id = $n` (cancel-by-booking; kind = 'booking' literal honoured).
        const byId = mine().filter((r) => whereVals.includes(r['id']));
        const kindRef = /(?<![\w.])kind\s*=\s*(?:'(\w+)'|\$(\d+))/i.exec(where); const kindVal = kindRef ? (kindRef[1] ?? values[Number(kindRef[2]) - 1]) : undefined;   // literal or bound kind filter
        const targets = byId.length ? byId : /source_ref_id\s*=/i.test(where) ? mine().filter((r) => whereVals.includes(r['source_ref_id']) && (kindVal === undefined || r['kind'] === kindVal)) : [];
        const guardsScheduled = /'scheduled'/i.test(where) || whereVals.includes('scheduled');
        const nums = whereVals.filter((v) => typeof v === 'number');
        const patch: Row = {}; let bump = false;
        for (const a of splitTop(setPart)) {
          const mm = /^(\w+)\s*=\s*(.+)$/.exec(a); if (!mm) continue; const col = mm[1]!, rhs = mm[2]!.trim();
          if (/^version\s*\+\s*1$/i.test(rhs)) { bump = true; continue; }
          if (/^\w+\s*\+\s*1$/.test(rhs)) continue;
          const co = /^coalesce\((.+),\s*(.+)\)$/i.exec(rhs); const v = lit(co ? co[2]! : rhs, values);
          if (v !== undefined) patch[col] = col.endsWith('_at') && v instanceof Date ? v.toISOString() : v;
        }
        const done: Row[] = [];
        for (const row of targets) {
          if (nums.length && !nums.includes(row['version'])) continue;
          if ('status' in patch && row['status'] !== 'scheduled') { if (guardsScheduled) continue; throw pgErr('23514', `reminders status machine: ${row['status']} -> ${patch['status']}`); }
          const next = { ...row, ...patch, ...(bump ? { version: row['version'] + 1 } : {}), updated_at: now() }; reminderCheck(next); Object.assign(row, next); done.push({ ...row });
        }
        return ok(/returning/i.test(sql) ? done : [], done.length);
      }
      if (verb === 'delete') throw new Error('reminders are never deleted (05-SCHEMA matrix: S I U)');
    }
    return ok([], 0);   // session settings, audit, anything else
  }

  const tx = (ctxRef: { current: any }) => ({ async query(text: string, values: unknown[] = []) { return exec(ctxRef.current, text, values); } });

  // ---- ports -----------------------------------------------------------------------------------------------------------------------------------------------
  const notif = {
    calls: [] as Array<{ method: string; actor: string; input: Record<string, any> }>,
    byKey: new Map<string, string>(),
    status: 'queued' as 'queued' | 'suppressed_no_consent' | 'suppressed_no_contact' | 'suppressed_channel_disabled',
    failNext: null as Error | null,
    crashAfterRecordOnce: false,
    async sendSms(ctx: any, input: Record<string, any>) {
      notif.calls.push({ method: 'sendSms', actor: ctx.actor.type, input: structuredClone(input) });
      if (notif.failNext) { const e = notif.failNext; notif.failNext = null; throw e; }
      const key = String(input['idempotencyKey']); const replayed = notif.byKey.has(key);
      const deliveryId = notif.byKey.get(key) ?? newId(); notif.byKey.set(key, deliveryId);
      if (notif.crashAfterRecordOnce) { notif.crashAfterRecordOnce = false; throw new Error('worker crashed after the provider call'); }
      return { deliveryId, status: notif.status, replayed };
    },
    sendWhatsAppTemplate: async () => { throw new Error('reminders are SMS only'); },
    sendEmailLink: async () => { throw new Error('reminders are SMS only'); },
  };
  const identity = {
    asserted: [] as Array<{ permission: string; actor: string; at: number }>,
    deny: new Set<string>(),
    async assertRole(ctx: any, req: { permission: string }) {
      identity.asserted.push({ permission: req.permission, actor: ctx.actor.type, at: stmts.length });
      if (identity.deny.has(req.permission)) throw new LimsError('auth.forbidden');
    },
    async getTenantSettings(ctx: any) { return { timezone: 'Asia/Kathmandu', calendarDisplay: 'AD', branding: { legalName: LAB_NAME, displayName: LAB_NAME } }; },
  };
  const ports = { NotificationPort: notif, IdentityPort: identity };

  // ---- seeding ---------------------------------------------------------------------------------------------------------------------------------------------
  const reminder = (over: Row = {}): Row => {
    const r: Row = { id: newId(), tenant_id: TENANT_A, patient_id: PATIENT, kind: 'custom', reason_code: 'follow_up_test', source: 'staff', source_ref_id: null, source_ref_seq: 0,
      due_at: now(), status: 'scheduled', sent_at: null, delivery_id: null, failure_code: null, version: 1, is_active: true, created_at: T0, created_by: SYSTEM_ACTOR, updated_at: T0, updated_by: SYSTEM_ACTOR, ...over };
    t['reminders']!.push(r); return r;
  };
  const account = (id: string, over: Row = {}) => { const a = { id, tenant_id: TENANT_A, status: 'active', reminders_opt_out: false, ...over }; t['accounts']!.push(a); return a; };
  const link = (accountId: string, patientId = PATIENT, over: Row = {}) => { const l = { id: newId(), tenant_id: TENANT_A, account_id: accountId, patient_id: patientId, status: 'active', ...over }; t['links']!.push(l); return l; };
  const booking = (over: Row = {}) => { const b = { id: newId(), tenant_id: TENANT_A, patient_id: PATIENT, booking_no: 'BK2600001', slot_start: '2026-03-02T05:00:00.000Z', status: 'confirmed', ...over }; t['bookings']!.push(b); return b; };

  // ---- contexts --------------------------------------------------------------------------------------------------------------------------------------------
  /** Worker JobContext (system actor). */
  const jobCtx = (over: Row = {}) => {
    const ref = { current: null as any };
    const ctx: any = { tenantId: TENANT_A, actor: { type: 'system', id: SYSTEM_ACTOR }, requestId: ID(0xe1), jobId: '1', attempt: 1, maxAttempts: 8, now, ports,
      log: { info() {}, warn() {}, error() {} }, audit: { access: async () => {}, event: async () => {} }, events: { publish: async () => {} }, ...over };
    ctx.tx = tx(ref); ref.current = ctx; ctx.db = { tx: async (fn: any) => fn(ctx) }; return ctx;
  };
  /** API RequestContext of front-desk staff. */
  const staffCtx = (over: Row = {}) => { const c = jobCtx({ actor: { type: 'user', id: ID(0x7a1) }, ...over }); return c; };

  const snapshot = () => structuredClone({ reminders: t['reminders'], notifications: t['notifications'], jobs: t['jobs'] });
  const restore = (s: ReturnType<typeof snapshot>) => { t['reminders'] = s.reminders!; t['notifications'] = s.notifications!; t['jobs'] = s.jobs!; };
  /** Run like the queue does: one transaction; DB state rolls back when the task throws (the port is NOT rolled back: its provider call happened). */
  async function runTask(task: (p: any, c: any) => Promise<void>, payload: Row, over: Row = {}) {
    const snap = snapshot(); const ctx = jobCtx(over);
    try { await task(payload, ctx); } catch (e) { restore(snap); throw e; }
  }

  return {
    t, stmts, now, advance: (ms: number) => { clock.t += ms; }, notif, identity, ports, jobCtx, staffCtx, runTask, newId,
    reminder, account, link, booking, REASONS,
    get: (id: string) => t['reminders']!.find((r) => r['id'] === id)!,
    jobs: (identifier?: string) => t['jobs']!.filter((j) => !identifier || j['identifier'] === identifier),
    notificationsOf: (accountId: string) => t['notifications']!.filter((n) => n['account_id'] === accountId),
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(verbOf(s.text))),
    reads: () => stmts.filter((s) => verbOf(s.text) === 'select'),
    setSetting: (k: string, v: unknown) => { t['settings']![0]![k] = v; },
  };
}
export type World = ReturnType<typeof makeWorld>;
