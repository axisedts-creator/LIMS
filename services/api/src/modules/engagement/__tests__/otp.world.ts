// C16.T-A2 test world (NOT a test file): in-memory engagement schema + port fakes shared by the API handler tests and the worker task tests of
// E1 getPatientAppConfig / E2 requestPatientOtp / task engagement.send_login_otp (02-TRD §4.1, §4.2, §5 E1-E2, §8.1; 05-SCHEMA otp_challenges, number_counters, settings).
// The fake `tx.query` answers by statement TYPE + table (never by exact SQL), like reminders.world.ts. Supported WHERE: AND of `col = x | <> x | != x | IN (..) | IS [NOT] NULL | < <= > >= x`;
// SET: `col = literal | $n | now() | col + <int|$n>` (table qualifiers ignored). Anything else throws "fake: unsupported ..." - write plain SQL.
// DB rules emulated from 05-SCHEMA: otp_challenges__hashes__ck (token_sha256 / code_hmac / phone_hmac are 32-BYTE Buffers, never hex strings - 08 A5.5), __phone__ck, __platform__ck,
// __status__ck, __attempts__ck, __ttl__ck (expires_at <= created_at + 10 min); number_counters__key__ck is READ FROM THE SPEC FILE (05-SCHEMA.md) so the daily-cap key is checked against the real regex.
// Rate limiter = the REAL core createRateLimiter (strict tier/prefix grammar) over an in-memory backend that honours the fake clock. Time = the fake clock, never the real one.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import testEnv from './test-env.js';
for (const [k, v] of Object.entries(testEnv)) if (process.env[k] === undefined) process.env[k] = v; // before any import of modules/engagement (config validated at import)
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { REPO_ROOT } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { createRateLimiter } from '../../../core/ratelimit/index.js';

export const TENANT_A: string = TENANTS.A;
export const TENANT_B: string = TENANTS.B;
export const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
export const SYSTEM_ACTOR = ID(0x7f1), APP_INSTANCE = ID(0xa11), APP_INSTANCE_2 = ID(0xa12);
export const LAB_NAME = 'Synthetic Lab Alpha';
export const T0 = '2026-03-01T04:00:00.000Z'; // 09:45 on 2026-03-01 in Asia/Kathmandu (+05:45)
export const PREFIX = '+99'; // C0 synthetic non-Nepali prefix family (01-PRD §AC preamble); tenant setting allowed_phone_prefixes = ['+990'] unless overridden
export const phoneN = (n: number) => `+990${String(10_000_000 + n).slice(-8)}`; // +990 + 8 digits = 12 digits total, E.164-valid, synthetic
export const OUTSIDE = '+14155550100'; // synthetic, outside allowed_phone_prefixes

type Row = Record<string, any>;
export interface Stmt { text: string; values: unknown[] }
const verbOf = (t: string) => /^\s*(select|insert|update|delete|with)\b/i.exec(t)?.[1]?.toLowerCase() ?? 'other';
const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });
const bytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const same = (a: unknown, b: unknown) => (bytes(a) && bytes(b) ? Buffer.from(a).equals(Buffer.from(b)) : a instanceof Date || b instanceof Date ? Date.parse(String(a)) === Date.parse(String(b)) : a === b);
const ts = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

// number_counters__key__ck, copied from the spec text (so the test follows the spec, not a hand-written regex)
const SPEC = readFileSync(join(REPO_ROOT, 'spec/chunks/C16-patient-engagement/05-SCHEMA.md'), 'utf8');
const KEY_RE_SRC = /number_counters__key__ck CHECK \(counter_key ~ '([^']+)'\)/.exec(SPEC)?.[1];
if (!KEY_RE_SRC) throw new Error('otp.world: number_counters__key__ck not found in 05-SCHEMA.md');
export const COUNTER_KEY_CK = new RegExp(KEY_RE_SRC);

export const keyFile = (name: 'OTP_HMAC_KEY_FILE' | 'PHONE_HMAC_KEY_FILE') => readFileSync(process.env[`LIMS_ENGAGEMENT_${name}`]!);
export const encKeys = (): Record<string, string> => JSON.parse(readFileSync(process.env['LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE']!, 'utf8'));
/** 02-TRD §4.1 step 1: HMAC-SHA256(otp key, challenge_id ‖ ':' ‖ code) as the raw 32-byte digest. */
export const codeHmac = (challengeId: string, code: string) => createHmac('sha256', keyFile('OTP_HMAC_KEY_FILE')).update(`${challengeId}:${code}`).digest();
/** 02-TRD §4.3: HMAC-SHA256(phone key, tenant_id ‖ ':' ‖ phone_e164). */
export const phoneHmac = (tenantId: string, phone: string) => createHmac('sha256', keyFile('PHONE_HMAC_KEY_FILE')).update(`${tenantId}:${phone}`).digest();

export function makeOtpWorld(opts: { prefixes?: string[]; appEnabled?: boolean; dailyCap?: number; tenantId?: string } = {}) {
  const tenantId = opts.tenantId ?? TENANT_A;
  const clock = { t: Date.parse(T0) };
  const now = () => new Date(clock.t).toISOString();
  const t: Record<string, Row[]> = { settings: [], challenges: [], counters: [], accounts: [], jobs: [] };
  const stmts: Stmt[] = [];
  let seq = 0x9000;
  const newId = () => ID(++seq);
  t['settings']!.push({
    id: newId(), tenant_id: tenantId, app_enabled: opts.appEnabled ?? true, bookings_enabled: true, home_collection_enabled: false, queue_enabled: true, reminders_enabled: true,
    memberships_enabled: false, enquiries_enabled: false, smart_report_in_app: true, show_partner_orders: false, auto_no_show: false, auto_follow_up_reminders: false,
    allowed_phone_prefixes: opts.prefixes ?? ['+990'], otp_daily_cap: opts.dailyCap ?? 2000, min_app_version_android: '1.2.3', min_app_version_ios: '1.2.4', version: 1,
  });

  // ---- tiny SQL helpers -----------------------------------------------------------------------------------------------------------------------------------
  const splitTop = (s: string) => { const out: string[] = []; let d = 0, q = false, cur = ''; for (const ch of s) { if (ch === "'") q = !q; if (!q && ch === '(') d++; if (!q && ch === ')') d--; if (ch === ',' && d === 0 && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const lit = (tokIn: string, values: unknown[]): unknown => {
    const tok = tokIn.trim().replace(/^\((.*)\)$/, '$1').replace(/\b[a-z_]+\.(?=[a-z_]+\b)/gi, (m) => (/^(\d+)\.$/.test(m) ? m : ''));
    const p = /^\$(\d+)(::\w+(\[\])?)?$/.exec(tok); if (p) return values[Number(p[1]) - 1];
    if (/^'.*'$/.test(tok)) return tok.slice(1, -1);
    if (/^(now|clock_timestamp|transaction_timestamp)\(\)$/i.test(tok)) return now();
    if (/^null$/i.test(tok)) return null; if (/^true$/i.test(tok)) return true; if (/^false$/i.test(tok)) return false;
    if (/^-?\d+$/.test(tok)) return Number(tok);
    return undefined;
  };
  const need = (tok: string, values: unknown[], what: string) => { const v = lit(tok, values); if (v === undefined) throw new Error(`fake: unsupported ${what} expression: ${tok}`); return v; };

  function matches(row: Row, where: string, values: unknown[]): boolean {
    for (const raw of where.split(/\s+and\s+/i)) {
      const pr = raw.trim().replace(/^\((.*)\)$/, '$1'); let m: RegExpExecArray | null;
      const cell = (c: string) => row[c.replace(/^.*\./, '')];
      if ((m = /^([\w.]+)\s+is\s+not\s+null$/i.exec(pr))) { if (cell(m[1]!) == null) return false; }
      else if ((m = /^([\w.]+)\s+is\s+null$/i.exec(pr))) { if (cell(m[1]!) != null) return false; }
      else if ((m = /^([\w.]+)\s+in\s*\((.*)\)$/i.exec(pr))) { if (!splitTop(m[2]!).map((x) => need(x, values, 'IN')).some((x) => same(cell(m![1]!), x))) return false; }
      else if ((m = /^([\w.]+)\s*(<>|!=)\s*(.+)$/.exec(pr))) { if (same(cell(m[1]!), need(m[3]!, values, 'WHERE'))) return false; }
      else if ((m = /^([\w.]+)\s*(<=|>=|<|>)\s*(.+)$/.exec(pr))) {
        const a = cell(m[1]!), b = need(m[3]!, values, 'WHERE'); const [x, y] = typeof a === 'number' ? [a, Number(b)] : [ts(a), ts(b)];
        if (!(m[2] === '<' ? x < y : m[2] === '<=' ? x <= y : m[2] === '>' ? x > y : x >= y)) return false;
      }
      else if ((m = /^([\w.]+)\s*=\s*(.+)$/.exec(pr))) { if (!same(cell(m[1]!), need(m[2]!, values, 'WHERE'))) return false; }
      else throw new Error(`fake: unsupported predicate: ${pr}`);
    }
    return true;
  }
  const applySet = (row: Row, setPart: string, values: unknown[]) => {
    const patch: Row = {};
    for (const a of splitTop(setPart)) {
      const mm = /^([\w.]+)\s*=\s*(.+)$/.exec(a); if (!mm) throw new Error(`fake: unsupported SET: ${a}`);
      const col = mm[1]!.replace(/^.*\./, ''), rhs = mm[2]!.trim(); let q: RegExpExecArray | null;
      if ((q = /^(?:[\w.]+\.)?(\w+)\s*\+\s*(\d+|\$\d+)$/.exec(rhs))) patch[col] = Number(row[q[1]!]) + Number(lit(q[2]!, values));
      else patch[col] = need(rhs, values, 'SET');
    }
    return patch;
  };

  // ---- DB rules of 05-SCHEMA ----------------------------------------------------------------------------------------------------------------------------
  function challengeCheck(r: Row) {
    for (const c of ['token_sha256', 'code_hmac', 'phone_hmac']) if (!bytes(r[c]) || (r[c] as Uint8Array).length !== 32) throw pgErr('23514', `otp_challenges__hashes__ck (${c} must be a 32-byte bytea, not ${typeof r[c]})`);
    if (!/^\+[1-9][0-9]{7,14}$/.test(String(r['phone_e164']))) throw pgErr('23514', 'otp_challenges__phone__ck');
    if (!['android', 'ios'].includes(r['app_platform'])) throw pgErr('23514', 'otp_challenges__platform__ck');
    if (!['pending', 'sent', 'verified', 'failed', 'superseded'].includes(r['status'])) throw pgErr('23514', 'otp_challenges__status__ck');
    if (!(r['attempts'] >= 0 && r['attempts'] <= 5)) throw pgErr('23514', 'otp_challenges__attempts__ck');
    if (!(ts(r['expires_at']) <= ts(r['created_at']) + 600_000)) throw pgErr('23514', 'otp_challenges__ttl__ck (expires_at <= created_at + 10 minutes)');
    if (t['challenges']!.some((o) => o['id'] !== r['id'] && o['tenant_id'] === r['tenant_id'] && same(o['token_sha256'], r['token_sha256']))) throw pgErr('23505', 'otp_challenges__tenant_id_token__uq');
  }

  /** claims.otp_token_sha256 (lowercase hex) -> 32-byte Buffer, like `decode(.., 'hex')` in the PRE_TOK / PRE_ACC policies (08 R24). */
  const hashOf = (ctx: any): Buffer | undefined => { const h = ctx?.claims?.otp_token_sha256; return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? Buffer.from(h, 'hex') : undefined; };
  /** accounts DDL rules (05-SCHEMA §3 accounts); `prev` = the row before an UPDATE (excluded from the unique checks). */
  function accountCheck(r: Row, prev: Row | null) {
    for (const c of ['id', 'created_by', 'updated_by']) if (r[c] == null) throw pgErr('23502', `accounts.${c} is NOT NULL`);
    if (!['active', 'deleted'].includes(r['status'])) throw pgErr('23514', 'accounts__status__ck');
    if (r['status'] !== 'deleted' && (!/^\+[1-9][0-9]{7,14}$/.test(String(r['phone_e164'])) || !bytes(r['phone_hmac']) || (r['phone_hmac'] as Uint8Array).length !== 32)) throw pgErr('23514', 'accounts__phone__ck (phone_hmac must be a 32-byte bytea)');
    if (r['last_app_platform'] != null && !['android', 'ios'].includes(r['last_app_platform'])) throw pgErr('23514', 'accounts__platform__ck');
    if (r['last_app_version'] != null && !/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/.test(String(r['last_app_version']))) throw pgErr('23514', 'accounts__app_version__ck');
    const others = t['accounts']!.filter((o) => o !== prev && o['tenant_id'] === r['tenant_id']);
    if (others.some((o) => o['id'] === r['id'])) throw pgErr('23505', 'accounts__pk');
    if (r['status'] === 'active' && others.some((o) => o['status'] === 'active' && (o['phone_e164'] === r['phone_e164'] || same(o['phone_hmac'], r['phone_hmac'])))) throw pgErr('23505', 'accounts__tenant_id_phone_e164__p_uq');
    if (r['membership_id'] != null && others.some((o) => o['membership_id'] === r['membership_id'])) throw pgErr('23505', 'accounts__tenant_id_membership_id__p_uq');
  }

  function exec(ctx: any, text: string, values: unknown[] = []): { rows: Row[]; rowCount: number } {
    stmts.push({ text, values });
    const sql = text.replace(/\s+/g, ' ').trim(); const verb = verbOf(sql); const tenant: string = ctx.tenantId;
    const ok = (rows: Row[], rowCount = rows.length) => ({ rows, rowCount });
    const tail = (s: string) => s.replace(/\s+(returning|for update|limit)\b.*$/i, '');

    if (/app\.enqueue_job/i.test(sql)) {
      let payload: any = values[1]; if (typeof payload === 'string') payload = JSON.parse(payload);
      const job = { identifier: String(values[0]), payload, jobKey: values[2], tenant };
      if (job.jobKey != null && t['jobs']!.some((j) => j['identifier'] === job.identifier && j['jobKey'] === job.jobKey)) return ok([{ enqueue_job: 1 }]);
      t['jobs']!.push(job); return ok([{ enqueue_job: 1 }]);
    }
    if (/engagement\.settings/i.test(sql) && verb === 'select') return ok(t['settings']!.filter((r) => r['tenant_id'] === tenant).map((r) => ({ ...r })));
    if (/engagement\.accounts/i.test(sql)) {
      // C16.T-A3: accounts with the PRE_ACC policy (05-SCHEMA §5.2/§5.3): a pre-auth patient sees/writes only the account whose phone_e164 equals the phone of
      // ITS OWN VERIFIED challenge (token_sha256 = claims.otp_token_sha256, status 'verified'); no verified challenge -> no row, writes -> 42501.
      const pre = ctx.claims?.patient_stage === 'pre_auth';
      const ownPhone = pre ? t['challenges']!.find((c) => c['tenant_id'] === tenant && c['status'] === 'verified' && hashOf(ctx) && same(c['token_sha256'], hashOf(ctx)))?.['phone_e164'] : undefined;
      const visible = (r: Row) => r['tenant_id'] === tenant && (!pre || (ownPhone !== undefined && r['phone_e164'] === ownPhone));
      const mine = () => t['accounts']!.filter(visible);
      if (verb === 'select') { const w = /\bwhere (.+)$/i.exec(tail(sql)); return ok(mine().filter((r) => !w || matches(r, w[1]!, values)).map((r) => ({ ...r }))); }
      if (verb === 'insert') {
        const m = /\(([^)]*)\)\s*values\s*\((.*?)\)\s*(?:returning .*)?$/i.exec(sql); if (!m) throw new Error(`fake: cannot parse accounts INSERT: ${sql}`);
        const cols = m[1]!.split(',').map((c) => c.trim()); const toks = splitTop(m[2]!);
        const row: Row = { tenant_id: tenant, membership_id: null, user_id: null, status: 'active', reminders_opt_out: false, last_login_at: null, last_app_platform: null, last_app_version: null, deleted_at: null, version: 1, is_active: true, created_at: now(), updated_at: now() };
        cols.forEach((c, i) => { row[c] = need(toks[i]!, values, 'accounts INSERT'); });
        if (row['tenant_id'] !== tenant || (pre && (ownPhone === undefined || row['phone_e164'] !== ownPhone))) throw pgErr('42501', 'RLS: accounts WITH CHECK (PRE_ACC: only the verified challenge phone)');
        accountCheck(row, null); t['accounts']!.push(row); return ok(/returning/i.test(sql) ? [{ ...row }] : [], 1);
      }
      if (verb === 'update') {
        const m = /set (.+?) where (.+?)(?: returning .*)?$/i.exec(sql); if (!m) throw new Error(`fake: cannot parse accounts UPDATE: ${sql}`);
        const hit = mine().filter((r) => matches(r, m[2]!, values));
        for (const r of hit) { const next = { ...r, ...applySet(r, m[1]!, values), updated_at: now() }; if (pre && next['phone_e164'] !== ownPhone) throw pgErr('42501', 'RLS: accounts WITH CHECK (PRE_ACC)'); accountCheck(next, r); Object.assign(r, next); }
        return ok(/returning/i.test(sql) ? hit.map((r) => ({ ...r })) : [], hit.length);
      }
      throw new Error('accounts are never deleted by the engagement API (status = deleted instead)');
    }

    if (/engagement\.number_counters/i.test(sql)) {
      if (verb === 'insert') {
        const m = /\(([^)]*)\)\s*values\s*\((.*?)\)\s*(?:on conflict\s*(?:\([^)]*\)|on constraint \w+)?\s*do (nothing|update set (.+?))\s*(?:where (.+?))?)?\s*(?:returning .*)?$/i.exec(sql);
        if (!m) throw new Error(`fake: cannot parse number_counters INSERT: ${sql}`);
        const cols = m[1]!.split(',').map((c) => c.trim()); const toks = splitTop(m[2]!); const row: Row = { tenant_id: tenant, last_value: 0, expires_at: null };
        cols.forEach((c, i) => { row[c] = need(toks[i]!, values, 'number_counters INSERT'); });
        if (row['tenant_id'] !== tenant) throw pgErr('42501', 'RLS: number_counters WITH CHECK (tenant_id = session tenant)');
        if (!COUNTER_KEY_CK.test(String(row['counter_key']))) throw pgErr('23514', `number_counters__key__ck (${String(row['counter_key'])})`);
        if (!(row['last_value'] >= 0)) throw pgErr('23514', 'number_counters__value__ck');
        const ex = t['counters']!.find((c) => c['tenant_id'] === tenant && c['counter_key'] === row['counter_key']);
        if (!ex) { t['counters']!.push(row); return ok(/returning/i.test(sql) ? [{ ...row }] : [], 1); }
        if (!m[3]) throw pgErr('23505', 'number_counters__pk');
        if (/^nothing/i.test(m[3])) return ok([], 0);
        const where = m[5]; if (where && !matches(ex, where, values)) return ok([], 0);   // conditional upsert, e.g. WHERE number_counters.last_value < $cap
        Object.assign(ex, applySet(ex, m[4]!, values)); return ok(/returning/i.test(sql) ? [{ ...ex }] : [], 1);
      }
      const mine = t['counters']!.filter((c) => c['tenant_id'] === tenant);
      if (verb === 'select') { const w = /\bwhere (.+)$/i.exec(tail(sql)); return ok(mine.filter((r) => !w || matches(r, w[1]!, values)).map((r) => ({ ...r }))); }
      if (verb === 'update') {
        const m = /set (.+?) where (.+?)(?: returning .*)?$/i.exec(sql); if (!m) throw new Error(`fake: cannot parse number_counters UPDATE: ${sql}`);
        const hit = mine.filter((r) => matches(r, m[2]!, values)); hit.forEach((r) => Object.assign(r, applySet(r, m[1]!, values)));
        return ok(/returning/i.test(sql) ? hit.map((r) => ({ ...r })) : [], hit.length);
      }
    }

    if (/engagement\.otp_challenges/i.test(sql)) {
      // PRE_TOK (05-SCHEMA §5.2): a request that carries claims.otp_token_sha256 sees/updates ONLY the challenge with that token hash.
      const tok = hashOf(ctx);
      const mine = () => t['challenges']!.filter((r) => r['tenant_id'] === tenant && (!tok || same(r['token_sha256'], tok)));
      if (verb === 'select') { const w = /\bwhere (.+)$/i.exec(tail(sql)); return ok(mine().filter((r) => !w || matches(r, w[1]!, values)).map((r) => ({ ...r }))); }
      if (verb === 'insert') {
        const m = /\(([^)]*)\)\s*values\s*\((.*?)\)\s*(?:on conflict.*?)?(?:returning .*)?$/i.exec(sql); if (!m) throw new Error(`fake: cannot parse otp_challenges INSERT: ${sql}`);
        const cols = m[1]!.split(',').map((c) => c.trim()); const toks = splitTop(m[2]!);
        const row: Row = { tenant_id: tenant, code_ciphertext: null, code_key_id: null, status: 'pending', attempts: 0, send_delivery_id: null, verified_at: null, consumed_at: null, created_at: now(), updated_at: now() };
        cols.forEach((c, i) => { row[c] = need(toks[i]!, values, 'otp_challenges INSERT'); });
        if (row['tenant_id'] !== tenant) throw pgErr('42501', 'RLS: otp_challenges WITH CHECK (tenant_id = session tenant)');
        challengeCheck(row); t['challenges']!.push(row); return ok(/returning/i.test(sql) ? [{ ...row }] : [], 1);
      }
      if (verb === 'update') {
        const m = /set (.+?) where (.+?)(?: returning .*)?$/i.exec(sql); if (!m) throw new Error(`fake: cannot parse otp_challenges UPDATE: ${sql}`);
        const hit = mine().filter((r) => matches(r, m[2]!, values));
        for (const r of hit) { const next = { ...r, ...applySet(r, m[1]!, values), updated_at: now() }; challengeCheck(next); Object.assign(r, next); }
        return ok(/returning/i.test(sql) ? hit.map((r) => ({ ...r })) : [], hit.length);
      }
      throw new Error('otp_challenges are deleted only by the purge task (05-SCHEMA matrix)');
    }
    return ok([], 0);   // session settings, audit, anything else
  }

  // ---- ports & spies --------------------------------------------------------------------------------------------------------------------------------------
  const notif = {
    calls: [] as Array<{ method: string; actor: string; input: Record<string, any> }>,
    byKey: new Map<string, string>(),
    status: 'queued' as 'queued' | 'suppressed_no_consent' | 'suppressed_no_contact' | 'suppressed_channel_disabled',
    failNext: null as Error | null,
    async sendSms(ctx: any, input: Record<string, any>) {
      notif.calls.push({ method: 'sendSms', actor: ctx.actor.type, input: structuredClone(input) });
      if (notif.failNext) { const e = notif.failNext; notif.failNext = null; throw e; }
      const key = String(input['idempotencyKey']); const replayed = notif.byKey.has(key);
      const deliveryId = notif.byKey.get(key) ?? newId(); notif.byKey.set(key, deliveryId);
      return { deliveryId, status: notif.status, replayed };
    },
    sendWhatsAppTemplate: async () => { throw new Error('OTP is SMS only'); },
    sendEmailLink: async () => { throw new Error('OTP is SMS only'); },
  };
  const identity = {
    settingsKeys: [] as string[][],
    async getTenantSettings(_ctx: any, input?: any) { identity.settingsKeys.push(Array.isArray(input?.keys) ? [...input.keys] : Array.isArray(input) ? [...input] : []); return { timezone: 'Asia/Kathmandu', calendarDisplay: 'AD_BS', branding: { legalName: LAB_NAME, displayName: LAB_NAME }, retentionYears: 7 }; },
  };
  const ports = { NotificationPort: notif, IdentityPort: identity };

  const logs: string[] = [];
  const logFn = (o: unknown, m?: unknown) => { logs.push(JSON.stringify({ o, m })); };
  const log = { info: logFn, warn: logFn, error: logFn, debug: logFn, child: () => log };
  const metricCalls: Array<{ name: string; labels: Record<string, string> }> = [];
  const metrics = { inc: (name: string, labels: Record<string, string> = {}) => { metricCalls.push({ name, labels }); }, set() {}, observe() {} };
  const audit: Row[] = [];

  const windows = new Map<string, number[]>(); const counters = new Map<string, { n: number; until: number }>();
  const limiter = createRateLimiter({
    hmacKey: 'test-only-key',
    backend: {
      async slidingWindow(h, w, limit) { const hits = (windows.get(h) ?? []).filter((x) => x > clock.t - w * 1000); if (hits.length >= limit) { windows.set(h, hits); return { allowed: false, retryAfterSeconds: Math.ceil((hits[0]! + w * 1000 - clock.t) / 1000) }; } hits.push(clock.t); windows.set(h, hits); return { allowed: true, retryAfterSeconds: 0 }; },
      async tokenBucket() { return { allowed: true, retryAfterSeconds: 0 }; },
      async counter(h, limit, ttl) { const c = counters.get(h); const cur = c && c.until > clock.t ? c : { n: 0, until: clock.t + ttl * 1000 }; cur.n++; counters.set(h, cur); return cur.n > limit ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true, retryAfterSeconds: 0 }; },
    },
  });
  const rateCalls: Array<{ tier: string; key: string }> = [];
  const rateLimit = { async consume(tier: any, key: string) { rateCalls.push({ tier, key }); return limiter.consume(tier, key); } };

  // ---- contexts --------------------------------------------------------------------------------------------------------------------------------------------
  const txOf = (ref: { current: any }) => ({ async query(text: string, values: unknown[] = []) { return exec(ref.current, text, values); } });
  const base = (over: Row) => {
    const ref = { current: null as any };
    const ctx: any = { tenantId, requestId: ID(0xe1), clientIp: '203.0.113.7', now, ports, log, metrics, rateLimit, audit: { access: async (e: Row) => { audit.push(structuredClone(e)); }, event: async () => {} }, events: { publish: async () => {} }, ...over };
    ctx.tx = txOf(ref); ref.current = ctx; ctx.db = { tx: async (fn: any) => fn(ctx) };
    ctx.commitOnError = () => { commit.requested = true; commit.calls++; };   // core pipeline: a 4xx/5xx still COMMITs the transaction (08 A19 P-42)
    return ctx;
  };
  const commit = { requested: false, calls: 0 };
  /** API RequestContext of a pre-auth patient (credential t.<tenant_code>, 02-TRD §4.2). */
  const preAuthCtx = (over: Row = {}) => base({ actor: { type: 'patient', id: ID(0xfe0) }, claims: { patient_stage: 'pre_auth' }, ...over });
  /** Worker JobContext (system actor). */
  const jobCtx = (over: Row = {}) => base({ actor: { type: 'system', id: SYSTEM_ACTOR }, jobId: '1', attempt: 1, maxAttempts: 3, ...over });

  /** API RequestContext of a pre-auth patient holding a challenge credential `c.<tenant_code>.<token>` (02-TRD §4.2): actor.id = challenge id, claims carry sha256(token) as lowercase hex. */
  const verifyCtx = (token: string, challengeId: string, over: Row = {}) =>
    base({ actor: { type: 'patient', id: challengeId }, claims: { patient_stage: 'pre_auth', otp_token_sha256: createHash('sha256').update(token).digest('hex') }, ...over });

  /** Deep copy that KEEPS Buffers (structuredClone would turn bytea Buffers into plain Uint8Arrays, which real pg never returns). */
  const deep = (v: any): any => (v instanceof Uint8Array ? Buffer.from(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  const snapshot = () => ({ ...deep({ challenges: t['challenges'], counters: t['counters'], jobs: t['jobs'], accounts: t['accounts'] }), auditLen: audit.length });
  const restore = (s: ReturnType<typeof snapshot>) => { t['challenges'] = s.challenges!; t['counters'] = s.counters!; t['jobs'] = s.jobs!; t['accounts'] = s.accounts!; audit.length = s.auditLen; };
  /** One transaction like the core pipeline / queue: DB state (incl. access-log rows) rolls back when the handler/task throws, UNLESS the handler called ctx.commitOnError()
   *  (the NotificationPort and the C2 fake are NOT rolled back: the provider / identity call happened). */
  async function inTx<T>(f: () => Promise<T>): Promise<T> {
    const snap = snapshot(); commit.requested = false;
    try { return await f(); } catch (e) { if (!commit.requested) restore(snap); throw e; }
  }

  return {
    tenantId, t, stmts, now, advance: (ms: number) => { clock.t += ms; }, setNow: (iso: string) => { clock.t = Date.parse(iso); }, newId,
    notif, identity, ports, logs, metricCalls, audit, rateCalls, jobCtx, preAuthCtx, verifyCtx, inTx, commit,
    setSetting: (k: string, v: unknown) => { t['settings']![0]![k] = v; },
    seedAccount: (phone: string, over: Row = {}) => {
      const a: Row = { id: newId(), tenant_id: tenantId, membership_id: null, user_id: null, phone_e164: phone, phone_hmac: phoneHmac(tenantId, phone), status: 'active', reminders_opt_out: false, last_login_at: null,
        last_app_platform: null, last_app_version: null, deleted_at: null, version: 1, is_active: true, created_at: now(), created_by: ID(0xfe1), updated_at: now(), updated_by: ID(0xfe1), ...over };
      accountCheck(a, null); t['accounts']!.push(a); return a;
    },
    accounts: () => t['accounts']!, account: (id: string) => t['accounts']!.find((a) => a['id'] === id),
    seedChallenge: (over: Row = {}) => {
      const phone = over['phone_e164'] ?? phoneN(1);
      const r: Row = { id: newId(), tenant_id: tenantId, token_sha256: randomBytes(32), phone_e164: phone, phone_hmac: phoneHmac(tenantId, phone), app_instance_id: APP_INSTANCE, app_platform: 'android', code_hmac: Buffer.alloc(32, 9),
        code_ciphertext: null, code_key_id: null, status: 'pending', attempts: 0, send_delivery_id: null, verified_at: null, consumed_at: null, created_at: now(), created_by: ID(0xfe0), expires_at: new Date(clock.t + 300_000).toISOString(), updated_at: now(), ...over };
      t['challenges']!.push(r); return r;
    },
    challenges: () => t['challenges']!, challenge: (id: string) => t['challenges']!.find((c) => c['id'] === id)!,
    jobs: (identifier?: string) => t['jobs']!.filter((j) => !identifier || j['identifier'] === identifier),
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(verbOf(s.text))),
    touched: (table: RegExp) => stmts.some((s) => table.test(s.text)),
    /** Everything an operator or attacker could read back: logs + audit rows + metric labels. */
    observed: () => JSON.stringify({ logs, audit, metricCalls }),
  };
}
export type OtpWorld = ReturnType<typeof makeOtpWorld>;
export { LimsError };
