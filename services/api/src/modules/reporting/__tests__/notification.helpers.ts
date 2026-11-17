// C6-T19 test helpers (not a test file). Synthetic data only.
// makeNotifWorld(): everything the REAL NotificationPort impl (ports/NotificationPort.impl.ts) needs, with NO network and NO real DB:
//   - db: in-memory fake of ONE Postgres transaction for reporting.g_message_templates / deliveries / centre_contacts + core.event_log + app.enqueue_job.
//     Models SQL by CONTENT (`col = $n` / `col = true` filters, INSERT ... VALUES ($n,..) [ON CONFLICT ..] [RETURNING], UPDATE ... SET .. WHERE ..,
//     ORDER BY a, b, LIMIT n). A statement WITHOUT a tenant predicate sees ALL tenants' rows (RLS is deliberately off). The CHECKs of 05-SCHEMA §2.8 that a
//     buggy writer could trip are enforced (channel/status/recipient_kind sets, template_code NULL <=> print|portal, destination_sha256 = 32 bytes, key <= 200).
//     Every write is journaled per tx object: world.rollback(tx) undoes it (AC-16.3, contract case 7).
//   - ctx.ports.FrontdeskPort = the REAL C0 fake (CR-C6-015 shape: non-system callers get contactPresence only), ctx.ports.IdentityPort = small stub that
//     answers getTenantSettings(channels) and getStaffNotificationContact exactly per 03-IC §4.6 / 08 A4.2 (system actors only).
//   - ctx.events = the REAL core createEvents (validates payloads against contracts/events), ctx.rateLimit = the REAL core createRateLimiter over an
//     in-memory sliding window (key grammar enforced: tier otp_request accepts keys with prefix `p:` only).
//   - env: the impl is created with createNotificationPort({ env }) and reads LIMS_ORIGIN_STAFF_WEB / LIMS_ORIGIN_PORTAL from it at call time.
import { createHash } from 'node:crypto';
import { createRateLimiter } from '../../../core/ratelimit/index.js';
import { createEvents } from '../../../core/events/publish.js';
import { LimsError } from '../../../core/errors.js';
import { createFakeFrontdeskPort } from '../../../../../../packages/fakes/src/FrontdeskPort.fake.js';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy.js';
import { TENANTS, FIXED_NOW, actorIdFor } from '../../../../../../packages/fakes/src/base.js';
import { createNotificationPort } from '../ports/NotificationPort.impl.js';

export const TENANT_A: string = TENANTS.A;
export const TENANT_B: string = TENANTS.B;
export const NOW = FIXED_NOW;
export type Row = Record<string, any>;
export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
export const idN = (n: number) => `0190b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

// ------------------------------------------------------------------------------------------------ template registry (what the seed must contain)
type P = [string, string];
const tpl = (code: string, purpose: string, channels: string[], params: P[]): Row =>
  ({ code, purpose, channels, params: params.map(([name, kind]) => ({ name, kind, max_length: kind === 'short_text' ? 40 : undefined })), default_texts: {}, is_active: true });
/** Mirrors 04-UI-UX §7. `ref` on registration_confirmation and the sms+whatsapp channels are kept so the C0 contract cases (which send `ref`, and try WhatsApp) stay valid. */
export const DEFAULT_TEMPLATES: Row[] = [
  tpl('frontdesk.registration_confirmation', 'registration_confirmation', ['sms', 'whatsapp'], [['lab_name', 'short_text'], ['registered_time_hhmm', 'time_hhmm'], ['ref', 'short_text']]),
  tpl('frontdesk.recollection_request', 'recollection_request', ['sms', 'whatsapp'], [['lab_name', 'short_text'], ['centre_phone', 'phone']]),
  tpl('reporting.report_ready', 'report_ready', ['whatsapp', 'sms', 'email'], [['lab_name', 'short_text'], ['url', 'url']]),
  tpl('reporting.critical_value_alert', 'critical_value_alert', ['sms', 'whatsapp'], [['lab_name', 'short_text'], ['lab_phone', 'phone'], ['ref', 'short_text']]),
  tpl('engagement.login_otp', 'otp', ['sms'], [['otp_code', 'otp_code'], ['lab_name', 'short_text'], ['minutes', 'minutes']]),
  tpl('analytics.report_ready', 'scheduled_report_ready', ['email'], [['lab_name', 'short_text'], ['schedule_name', 'label_text'], ['url', 'staff_url']]),
  tpl('reporting.dues_due', 'dues_reminder', ['sms', 'whatsapp'], [['lab_name', 'short_text'], ['amount_text', 'short_text'], ['url', 'url']]),
  tpl('homecollection.visit_assigned', 'visit_assignment', ['sms'], [['route_date', 'short_text'], ['visit_count', 'short_text']]),
  tpl('engagement.booking_cancelled', 'booking_cancelled', ['sms'], [['lab_name', 'short_text'], ['datetime', 'datetime'], ['booking_no', 'short_text']]),
  tpl('engagement.booking_reminder', 'booking_reminder', ['sms'], [['lab_name', 'short_text'], ['datetime', 'datetime'], ['booking_no', 'short_text']]),
  tpl('homecollection.visit_scheduled', 'booking_confirmation', ['sms'], [['window_start_local', 'short_text'], ['window_end_local', 'short_text']]),
];

// ------------------------------------------------------------------------------------------------ fake transaction
const SETS = {
  channel: ['whatsapp', 'sms', 'email', 'print', 'portal'], status: ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'],
  recipient_kind: ['patient', 'referrer', 'centre', 'partner', 'staff', 'phone_otp'],
  related: ['order', 'report', 'specimen', 'booking', 'visit', 'critical_event', 'report_run'],
};
const DEFAULTS: Record<string, Row> = {
  deliveries: { language: 'en', attempt_no: 1, params: {}, status: 'queued', centre_id: null, recipient_id: null, destination_masked: null, destination_sha256: null,
    destination_e164: null, failure_code: null, related_entity_type: null, related_entity_id: null, report_id: null, report_version_no: null, deferred_link: null,
    link_id: null, fallback_of_delivery_id: null, queued_at: null, suppressed_at: null },
  centre_contacts: { is_active: true, label: null },
  g_message_templates: { is_active: true, default_texts: {} },
};
const UNIQUE: Record<string, string[][]> = { deliveries: [['tenant_id', 'idempotency_key']], centre_contacts: [], g_message_templates: [['code']] };
const JSON_COLS = new Set(['params', 'deferred_link', 'default_texts']);

function splitComma(s: string): string[] { const out: string[] = []; let d = 0; let q = false; let cur = ''; for (const ch of s) { if (ch === "'") q = !q; if (!q && ch === '(') d++; if (!q && ch === ')') d--; if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
function topLevelGroups(s: string): string[] { const out: string[] = []; let d = 0; let cur = ''; for (const ch of s) { if (ch === '(') { if (d++ === 0) { cur = ''; continue; } } else if (ch === ')') { if (--d === 0) { out.push(cur); continue; } } if (d > 0) cur += ch; } return out; }

export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly verb: string }
export interface Job { identifier: string; payload: any; jobKey: unknown; tx: unknown }

export function makeNotifDb() {
  const store: Record<string, Row[]> = { g_message_templates: [], deliveries: [], centre_contacts: [], event_log: [] };
  const stmts: Stmt[] = []; const jobs: Job[] = []; const journal = new Map<unknown, Array<() => void>>();
  let idSeq = 0x5000; let clock = 0;
  const newId = () => idN(++idSeq);
  const undo = (tx: unknown, fn: () => void) => { (journal.get(tx) ?? journal.set(tx, []).get(tx)!).push(fn); };
  const parse = (col: string, v: unknown) => (JSON_COLS.has(col) && typeof v === 'string' ? JSON.parse(v) : v);
  const tokenValue = (t: string, values: readonly unknown[]): unknown => {
    const p = /\$(\d+)/.exec(t)?.[1]; if (p) return values[Number(p) - 1];
    if (/^now\(\)$/i.test(t) || /^clock_timestamp\(\)$/i.test(t)) return NOW;
    if (/^(?:\w+\.)?(gen_random_uuid|uuidv7|uuid_generate_v7)\(\)$/i.test(t)) return newId();
    if (/^null$/i.test(t)) return null; if (/^true$/i.test(t)) return true; if (/^false$/i.test(t)) return false;
    if (/^-?\d+$/.test(t)) return Number(t); return t.replace(/^'|'$/g, '');
  };
  const eqFilters = (where: string, values: readonly unknown[]) => [
    ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)(?:::\w+)?/g)].map((m) => [m[1]!, values[Number(m[2]) - 1]] as const),
    ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*'([^']*)'/g)].map((m) => [m[1]!, m[2]!] as const),
    ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*(true|false)\b/gi)].map((m) => [m[1]!, m[2]!.toLowerCase() === 'true'] as const),
  ];
  const matches = (r: Row, f: ReadonlyArray<readonly [string, unknown]>) => f.every(([c, v]) => v === undefined || v === null || !(c in r) || r[c] === v || (Buffer.isBuffer(r[c]) && Buffer.isBuffer(v) && r[c].equals(v)));

  function checks(table: string, row: Row) {
    if (table !== 'deliveries') return;
    const bad = (m: string) => { throw pgError('23514', `deliveries check violated: ${m}`); };
    for (const c of ['tenant_id', 'channel', 'purpose', 'recipient_kind', 'idempotency_key', 'status']) if (row[c] === undefined || row[c] === null) throw pgError('23502', `null ${c}`);
    if (!SETS.channel.includes(row['channel'])) bad('channel'); if (!SETS.status.includes(row['status'])) bad('status');
    if (!SETS.recipient_kind.includes(row['recipient_kind'])) bad('recipient_kind');
    if (row['related_entity_type'] != null && !SETS.related.includes(row['related_entity_type'])) bad('related_entity_type');
    if (String(row['idempotency_key']).length > 200) bad('idempotency_key length');
    if ((['print', 'portal'].includes(row['channel'])) !== (row['template_code'] == null)) bad('template_code NULL <=> print|portal');
    if (row['destination_sha256'] != null && !(Buffer.isBuffer(row['destination_sha256']) && row['destination_sha256'].length === 32)) bad('destination_sha256 must be 32 bytes');
    if (row['destination_e164'] != null && row['recipient_kind'] !== 'phone_otp') bad('destination_e164 only for phone_otp');
    if (typeof row['params'] !== 'object' || row['params'] === null || Array.isArray(row['params'])) bad('params object');
    if (row['template_code'] != null && !store['g_message_templates']!.some((t) => t['code'] === row['template_code'])) throw pgError('23503', 'fk template_code');
  }

  function exec(tx: unknown, text: string, values: readonly unknown[]): Row[] {
    if (/\bapp\.enqueue_job\s*\(/i.test(text)) {
      let payload: any = values[1]; if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* keep */ } }
      const j: Job = { identifier: String(values[0]), payload, jobKey: values[2], tx }; jobs.push(j); undo(tx, () => { jobs.splice(jobs.indexOf(j), 1); });
      return [{ enqueue_job: 1 }];
    }
    if (/\binsert\s+into\s+core\.event_log\b/i.test(text)) {   // core.events.publish: (tenant, event_id, type, producer, key, agg_type, agg_id, seq, at, envelope, by)
      const [tenant, eventId, type, , key] = values as string[];
      if (store['event_log']!.some((e) => e['tenant_id'] === tenant && e['event_type'] === type && e['idempotency_key'] === key)) return [];
      const row = { tenant_id: tenant, event_id: eventId, event_type: type, idempotency_key: key, envelope: values[9] };
      store['event_log']!.push(row); undo(tx, () => { store['event_log']!.splice(store['event_log']!.indexOf(row), 1); }); return [{ event_id: eventId }];
    }
    if (/\bfrom\s+core\.event_log\b/i.test(text)) return store['event_log']!.filter((e) => e['tenant_id'] === values[0] && e['event_type'] === values[1] && e['idempotency_key'] === values[2]).map((e) => ({ event_id: e['event_id'] }));
    const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase();
    const table = /(?:from|into|update)\s+reporting\.(\w+)/i.exec(text)?.[1];
    if (!table || !(table in store)) return [];
    const rows = store[table]!;
    if (verb === 'delete') throw pgError('42501', 'permission denied: no DELETE grant');
    if (verb === 'select') {
      const where = /\bwhere\b([\s\S]*?)(?:\border\s+by\b|\blimit\b|\bfor\s+update\b|$)/i.exec(text)?.[1] ?? '';
      let hit = rows.filter((r) => matches(r, eqFilters(where, values)));
      const ob = /\border\s+by\s+([\w\s,.]+?)(?:\blimit\b|\bfor\s+update\b|$)/i.exec(text)?.[1];
      if (ob) { const cols = ob.split(',').map((c) => c.trim().split(/\s+/)[0]!.replace(/^\w+\./, '')); hit = [...hit].sort((a, b) => { for (const c of cols) { const x = a[c] ?? '', y = b[c] ?? ''; if (x < y) return -1; if (x > y) return 1; } return 0; }); }
      const lim = /\blimit\s+(\$\d+|\d+)/i.exec(text)?.[1]; if (lim) hit = hit.slice(0, Number(tokenValue(lim, values)));
      return hit.map((r) => ({ ...r }));
    }
    if (verb === 'update') {
      const m = /\bset\b([\s\S]*?)\bwhere\b([\s\S]*?)(?:\breturning\b|$)/i.exec(text); if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: UPDATE without WHERE');
      const hit = rows.filter((r) => matches(r, eqFilters(m[2]!, values)));
      for (const r of hit) {
        const before = { ...r };
        for (const a of splitComma(m[1]!)) { const mm = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(a); if (!mm) continue; const rhs = mm[2]!.trim().replace(/::\w+(\[\])?$/, ''); r[mm[1]!] = parse(mm[1]!, tokenValue(rhs, values)); }
        checks(table, r); undo(tx, () => { Object.assign(r, before); });
      }
      return /\breturning\b/i.test(text) ? hit.map((r) => ({ ...r })) : [];
    }
    if (verb === 'insert') {
      const m = /into\s+reporting\.\w+\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b([\s\S]*?))?(?:\breturning\b[\s\S]*)?$/i.exec(text);
      if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: INSERT must be `INSERT INTO reporting.t (cols) VALUES ($1, ...)`');
      const cols = m[1]!.split(',').map((c) => c.trim()); const out: Row[] = [];
      for (const g of topLevelGroups(m[2]!)) {
        const toks = splitComma(g); const row: Row = { ...DEFAULTS[table] };
        cols.forEach((c, i) => { const t = toks[i]!; if (/^default$/i.test(t)) return; row[c] = parse(c, tokenValue(t, values)); });
        if (row['id'] === undefined) row['id'] = newId();
        row['created_at'] = row['created_at'] ?? `${NOW.slice(0, 19)}.${String(++clock).padStart(3, '0')}Z`;
        if (table === 'deliveries' && row['status'] === 'queued') row['queued_at'] = row['queued_at'] ?? NOW;
        if (table === 'deliveries' && row['status'] === 'suppressed') row['suppressed_at'] = row['suppressed_at'] ?? NOW;
        checks(table, row);
        const dup = rows.find((e) => (UNIQUE[table] ?? []).some((u) => u.every((c) => e[c] === row[c])));
        if (dup) { if (!m[3]) throw pgError('23505', 'duplicate key'); continue; }   // ON CONFLICT ... DO NOTHING (DO UPDATE is not modelled: deliveries are immutable)
        rows.push(row); undo(tx, () => { rows.splice(rows.indexOf(row), 1); }); out.push({ ...row });
      }
      return /\breturning\b/i.test(text) ? out : [];
    }
    return [];
  }

  function newTx() {
    const tx: any = {
      startedAt: new Date(NOW),
      async query(text: string, values: unknown[] = []) { stmts.push({ text, values: [...values], verb: (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase() }); return { rows: exec(tx, text, values) }; },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
    };
    return tx;
  }
  return {
    store, stmts, jobs, newTx,
    rollback(tx: unknown) { const j = journal.get(tx) ?? []; journal.delete(tx); for (const f of j.reverse()) f(); },
    deliveries: () => store['deliveries']!, delivery: (id: string) => store['deliveries']!.find((r) => r['id'] === id),
    jobsOf: (identifier: string) => jobs.filter((j) => j.identifier === identifier),
    events: () => store['event_log']!,
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(s.verb)),
  };
}
export type NotifDb = ReturnType<typeof makeNotifDb>;

// ------------------------------------------------------------------------------------------------ the world
export interface StaffContactFx { id: string; tenantId: string; membershipId: string; email: string | null; status: string; actorType: string; locked: boolean; permissions: string[] }
export const STAFF_ORIGIN = 'https://staff.lims.invalid';
export const PORTAL_ORIGIN = 'https://portal.lims.invalid';

export function makeNotifWorld() {
  const db = makeNotifDb();
  db.store['g_message_templates']!.push(...DEFAULT_TEMPLATES.map((t) => ({ ...t })));
  const env: Record<string, string | undefined> = { LIMS_ORIGIN_STAFF_WEB: STAFF_ORIGIN, LIMS_ORIGIN_PORTAL: PORTAL_ORIGIN };
  const events = createEventSpy();
  const frontdesk: any = createFakeFrontdeskPort({ seed: 1, events });
  let staff: StaffContactFx[] = [];
  let channels: Record<string, { smsEnabled: boolean; whatsappEnabled: boolean; emailEnabled: boolean }> = {};
  const identityCalls: Array<{ method: string; actorType: string; input: any }> = [];
  const identity = {
    async getTenantSettings(ctx: any, input: any) {
      identityCalls.push({ method: 'getTenantSettings', actorType: ctx.actor.type, input });
      return { channels: channels[ctx.tenantId] ?? { smsEnabled: false, whatsappEnabled: false, emailEnabled: false } };
    },
    async getStaffNotificationContact(ctx: any, input: any) {
      identityCalls.push({ method: 'getStaffNotificationContact', actorType: ctx.actor.type, input });
      if (ctx.actor.type !== 'system') throw new LimsError('auth.forbidden');   // 03-IC §4.6: system actors only
      const c = staff.find((s) => s.tenantId === ctx.tenantId && s.membershipId === input.membershipId);
      const eligible = !!c && c.status === 'active' && c.actorType === 'user' && !c.locked && c.permissions.includes(input.requiredPermission);
      return { membershipId: input.membershipId, email: c?.email ?? null, eligible };
    },
  };
  const hits = new Map<string, number>();
  const limiter = createRateLimiter({
    hmacKey: 'test-only-key',
    backend: {
      async slidingWindow(h, _w, limit) { const n = hits.get(h) ?? 0; if (n >= limit) return { allowed: false, retryAfterSeconds: 60 }; hits.set(h, n + 1); return { allowed: true, retryAfterSeconds: 0 }; },
      async tokenBucket() { return { allowed: true, retryAfterSeconds: 0 }; },
      async counter() { return { allowed: true, retryAfterSeconds: 0 }; },
    },
  });
  const rateCalls: Array<{ tier: string; key: string }> = [];
  const rateLimit = { async consume(tier: any, key: string) { rateCalls.push({ tier, key }); return limiter.consume(tier, key); } };
  const coreEvents = createEvents({ producer: 'reporting' });
  const impl: any = createNotificationPort({ env } as any);

  function ctxFor(actorKey: string, over: Row = {}): any {
    const [t = 'A', type = 'user', persona = 'default'] = actorKey.split(':');
    if (!(t in TENANTS)) throw new Error(`unknown tenant key ${t}`);
    return {
      tenantId: TENANTS[t as 'A' | 'B'], actor: { type, id: actorIdFor(t as 'A' | 'B', type, persona) }, requestId: '01900000-0000-7000-8000-0000000000e1',
      tx: db.newTx(), now: () => NOW, ports: { FrontdeskPort: frontdesk, IdentityPort: identity }, events: coreEvents, rateLimit, ...over,
    };
  }
  const sys = (t: 'A' | 'B' = 'A') => ctxFor(`${t}:system`);

  /** Contract fixtures (NotificationFixtures) + optional extras. */
  async function seed(fx: Row) {
    if (Array.isArray(fx['templates'])) { db.store['g_message_templates']!.length = 0; db.store['g_message_templates']!.push(...fx['templates'].map((t: Row) => ({ ...t }))); }
    if (Array.isArray(fx['recipients'])) {
      frontdesk.__seed({ patients: fx['recipients'].filter((r: Row) => r.kind === 'patient').map((r: Row) => ({
        id: r.id, tenantId: r.tenantId, patientCode: `P-${String(r.id).slice(-4)}`, fullName: r.fullName ?? 'Test Patient 0001', sex: 'female',
        ...(r.phoneE164 ? { phoneE164: r.phoneE164 } : {}), ...(r.email ? { email: r.email } : {}),
        consents: { ...r.consent, shareWithReferrer: false, consentTextVersion: 'v1' }, status: 'active' })) });
    }
    if (Array.isArray(fx['staffContacts'])) staff = fx['staffContacts'];
    if (fx['channels']) channels = fx['channels'];
    if (fx['staffWebOrigin']) env['LIMS_ORIGIN_STAFF_WEB'] = fx['staffWebOrigin'];
    for (const c of fx['centreContacts'] ?? []) db.store['centre_contacts']!.push({ is_active: true, label: null, created_at: NOW, ...c });
  }
  return {
    db, env, impl, frontdesk, identity, identityCalls, rateCalls, ctxFor, sys, seed, events: db.events,
    rollback: (tx: unknown) => db.rollback(tx),
    harness: { impl, seed, ctxFor, events, rollback: (tx: unknown) => { db.rollback(tx); events.rollback(tx); } },
  };
}
export type NotifWorld = ReturnType<typeof makeNotifWorld>;
