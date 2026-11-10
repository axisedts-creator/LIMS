// C6-T25 test helpers (not a test file). Synthetic data only.
// makeMsgWorld(): the REAL manifest handlers need only a ctx; this builds one over an in-memory fake of ONE Postgres transaction for
//   reporting.g_message_templates (global, no tenant), reporting.message_template_texts and reporting.channel_accounts (05-SCHEMA §2.8/§2.9 DDL).
//   Models SQL by CONTENT: `col = $n` / `col = 'lit'` / `col = true|false` filters (a statement WITHOUT a tenant predicate sees ALL tenants' rows),
//   INSERT ... VALUES ($n,..) [ON CONFLICT (..) DO NOTHING | DO UPDATE SET .. [WHERE ..]] [RETURNING], UPDATE ... SET .. WHERE .. [RETURNING],
//   `version = version + 1`, `COALESCE($n, col)`, `now()`, `excluded.col`, ORDER BY a, b, LIMIT n. NO joins, `= ANY($n)` or aggregates.
//   CHECK / UNIQUE / FK of the three tables are enforced (23514 / 23505 / 23503). Every statement is journaled: stmts(); idemStmts() are those that
//   mention `idempotency_keys` (the done_when says there must be none holding a callback token).
import { createHash } from 'node:crypto';
import { DEFAULT_TEMPLATES } from './notification.helpers.js';
import { MEM, REQ_ID, TENANT_A, TENANT_B, USER, idN, pgError } from './settings.helpers.js';

export { MEM, REQ_ID, TENANT_A, TENANT_B, USER, idN, pgError };
export type Row = Record<string, any>;
export const NOW = '2026-11-08T08:00:00.000Z';
export const sha256buf = (s: string): Buffer => createHash('sha256').update(s).digest();
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

// ------------------------------------------------------------------------------------------------ fixtures
export const TXT_A_WA = idN(0xa101);   // tenant A  reporting.report_ready / whatsapp / en  (version 2)
export const TXT_A_SMS = idN(0xa102);  // tenant A  reporting.report_ready / sms / en       (version 1)
export const TXT_B_WA = idN(0xa1b1);   // tenant B  reporting.report_ready / whatsapp / en  (version 5)
export const ACC_A_SMS = idN(0xa201);  // tenant A sms: recording, version 3, NO callback token yet
export const ACC_A_WA = idN(0xa202);   // tenant A whatsapp: version 1, callback token OLD_TOKEN configured
export const ACC_B_SMS = idN(0xa2b1);  // tenant B sms: version 1, callback token B_TOKEN configured
export const OLD_TOKEN = 'OLD-TOKEN-' + 'a'.repeat(33);   // 43 chars like a real base64url 256-bit token
export const B_TOKEN = 'B-TOKEN--' + 'b'.repeat(34);
export const INACTIVE_CODE = 'reporting.retired_one';

export const textRow = (id: string, tenant: string, code: string, channel: string, language: string, o: Row = {}): Row => ({
  id, tenant_id: tenant, template_code: code, channel, language, body_text: `Synthetic ${channel} text {lab_name}`, subject_text: null, provider_template_name: null,
  provider_template_language: null, provider_variable_order: null, approval_status: 'not_required', approval_recorded_by: null, approval_recorded_at: null,
  version: 1, is_active: true, created_by: USER, updated_by: USER, ...o,
});
export const acctRow = (id: string, tenant: string, channel: string, o: Row = {}): Row => ({
  id, tenant_id: tenant, channel, provider_kind: 'recording', sender_id: null, secret_ref: `secrets/${channel}-synthetic`, callback_token_sha256: null,
  version: 1, is_active: true, created_by: USER, updated_by: USER, ...o,
});
export function seedAll(): Record<string, Row[]> {
  return {
    g_message_templates: [...DEFAULT_TEMPLATES.map((t) => ({ ...t })), { code: INACTIVE_CODE, purpose: 'report_ready', channels: ['sms'], params: [{ name: 'lab_name', kind: 'short_text', max_length: 40 }], default_texts: {}, is_active: false }],
    message_template_texts: [
      textRow(TXT_A_WA, TENANT_A, 'reporting.report_ready', 'whatsapp', 'en', { version: 2, body_text: 'Existing A whatsapp {lab_name} {url}' }),
      textRow(TXT_A_SMS, TENANT_A, 'reporting.report_ready', 'sms', 'en', { body_text: 'Existing A sms {lab_name} {url}' }),
      textRow(TXT_B_WA, TENANT_B, 'reporting.report_ready', 'whatsapp', 'en', { version: 5, body_text: 'TENANT-B-ONLY whatsapp text {lab_name}' }),
    ],
    channel_accounts: [
      acctRow(ACC_A_SMS, TENANT_A, 'sms', { version: 3, sender_id: 'LABA', secret_ref: 'secrets/sms-a' }),
      acctRow(ACC_A_WA, TENANT_A, 'whatsapp', { provider_kind: 'whatsapp_cloud_api', secret_ref: 'secrets/wa-a', callback_token_sha256: sha256buf(OLD_TOKEN) }),
      acctRow(ACC_B_SMS, TENANT_B, 'sms', { version: 1, secret_ref: 'secrets/sms-b', callback_token_sha256: sha256buf(B_TOKEN) }),
    ],
  };
}

// ------------------------------------------------------------------------------------------------ fake transaction
const DEFAULTS: Record<string, Row> = {
  g_message_templates: { is_active: true, default_texts: {} },
  message_template_texts: { subject_text: null, provider_template_name: null, provider_template_language: null, provider_variable_order: null, approval_status: 'not_required', approval_recorded_by: null, approval_recorded_at: null, version: 1, is_active: true },
  channel_accounts: { sender_id: null, callback_token_sha256: null, version: 1, is_active: true },
};
const UNIQUE: Record<string, string[][]> = {
  g_message_templates: [['code']],
  message_template_texts: [['tenant_id', 'id'], ['tenant_id', 'template_code', 'channel', 'language']],
  channel_accounts: [['tenant_id', 'id'], ['tenant_id', 'channel']],
};
const JSON_COLS = new Set(['params', 'default_texts']);
const same = (a: unknown, b: unknown) => a === b || (a != null && b != null && typeof a === 'object' && typeof b === 'object' && Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array)));

function splitComma(s: string): string[] { const out: string[] = []; let d = 0; let q = false; let cur = ''; for (const ch of s) { if (ch === "'") q = !q; if (!q && ch === '(') d++; if (!q && ch === ')') d--; if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
function topLevelGroups(s: string): string[] { const out: string[] = []; let d = 0; let cur = ''; for (const ch of s) { if (ch === '(') { if (d++ === 0) { cur = ''; continue; } } else if (ch === ')') { if (--d === 0) { out.push(cur); continue; } } if (d > 0) cur += ch; } return out; }

export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly verb: string }

export function makeMsgDb(seed: Record<string, Row[]> = seedAll()) {
  const store: Record<string, Row[]> = {};
  for (const t of Object.keys(DEFAULTS)) store[t] = (seed[t] ?? []).map((r) => ({ ...DEFAULTS[t], ...r }));
  const stmts: Stmt[] = []; let idSeq = 0x7000;
  const parse = (col: string, v: unknown) => (JSON_COLS.has(col) && typeof v === 'string' ? JSON.parse(v) : v);
  const tokenValue = (t: string, values: readonly unknown[]): unknown => {
    const p = /^\$(\d+)/.exec(t)?.[1]; if (p) return values[Number(p) - 1];
    if (/^(now|clock_timestamp)\(\)$/i.test(t)) return NOW;
    if (/^(?:\w+\.)?(gen_random_uuid|uuidv7|uuid_generate_v7)\(\)$/i.test(t)) return idN(++idSeq);
    if (/^null$/i.test(t)) return null; if (/^true$/i.test(t)) return true; if (/^false$/i.test(t)) return false;
    if (/^-?\d+$/.test(t)) return Number(t); return t.replace(/^'|'$/g, '');
  };
  const eqFilters = (where: string, values: readonly unknown[]) => [
    ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)(?:::\w+)?/g)].map((m) => [m[1]!, values[Number(m[2]) - 1]] as const),
    ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*'([^']*)'/g)].map((m) => [m[1]!, m[2]!] as const),
    ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*(true|false)\b/gi)].map((m) => [m[1]!, m[2]!.toLowerCase() === 'true'] as const),
  ];
  const matches = (r: Row, f: ReadonlyArray<readonly [string, unknown]>) => f.every(([c, v]) => v === undefined || v === null || !(c in r) || same(r[c], v));
  function applySet(r: Row, set: string, values: readonly unknown[], excluded?: Row) {
    for (const a of splitComma(set)) {
      const m = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(a); if (!m) continue;
      const col = m[1]!; const rhs = m[2]!.trim().replace(/::\w+(\[\])?$/, '');
      if (/^(?:[\w.]+\.)?version\s*\+\s*1$/i.test(rhs)) r[col] = (r[col] ?? 0) + 1;
      else if (/^excluded\.(\w+)/i.test(rhs)) r[col] = excluded?.[/^excluded\.(\w+)/i.exec(rhs)![1]!];
      else if (/^coalesce\(\s*\$(\d+)/i.test(rhs)) { const v = values[Number(/^coalesce\(\s*\$(\d+)/i.exec(rhs)![1]) - 1]; if (v !== null && v !== undefined) r[col] = v; }
      else if (!/\(/.test(rhs) || /^\$\d+/.test(rhs) || /^now\(\)$/i.test(rhs)) r[col] = parse(col, tokenValue(rhs, values));
    }
  }
  function checks(table: string, row: Row, orig?: Row) {
    const bad = (m: string) => { throw pgError('23514', `${table} check violated: ${m}`); };
    if (table === 'message_template_texts') {
      for (const c of ['tenant_id', 'template_code', 'channel', 'language', 'body_text', 'created_by', 'updated_by']) if (row[c] == null) throw pgError('23502', `null ${c}`);
      if (!['whatsapp', 'sms', 'email'].includes(row['channel'])) bad('channel'); if (!['en', 'ne'].includes(row['language'])) bad('language');
      const L = (s: unknown) => typeof s === 'string' ? s.length : 0;
      if (L(row['body_text']) < 1 || L(row['body_text']) > 1000) bad('body_text length'); if (row['subject_text'] != null && L(row['subject_text']) > 150) bad('subject_text');
      if (row['provider_template_name'] != null && L(row['provider_template_name']) > 128) bad('provider_template_name'); if (row['provider_template_language'] != null && L(row['provider_template_language']) > 16) bad('provider_template_language');
      if (!['not_required', 'draft', 'submitted', 'approved', 'rejected'].includes(row['approval_status'])) bad('approval_status');
      if (!store['g_message_templates']!.some((t) => t['code'] === row['template_code'])) throw pgError('23503', 'fk template_code');
    }
    if (table === 'channel_accounts') {
      for (const c of ['tenant_id', 'channel', 'provider_kind', 'secret_ref', 'created_by', 'updated_by']) if (row[c] == null) throw pgError('23502', `null ${c}`);
      if (!['whatsapp', 'sms', 'email'].includes(row['channel'])) bad('channel');
      if (!['recording', 'whatsapp_cloud_api', 'sms_sparrow', 'sms_aakash', 'email_smtp_relay'].includes(row['provider_kind'])) bad('provider_kind');
      if (row['sender_id'] != null && String(row['sender_id']).length > 64) bad('sender_id'); if (!/^[a-z0-9_./-]{1,128}$/.test(String(row['secret_ref']))) bad('secret_ref');
      const h = row['callback_token_sha256']; if (h != null && !(Buffer.isBuffer(h) || h instanceof Uint8Array)) bad('callback_token_sha256 must be bytea'); if (h != null && Buffer.from(h).length !== 32) bad('callback_token_sha256 must be 32 bytes');
      if (h != null && store['channel_accounts']!.some((o) => o !== orig &&o['callback_token_sha256'] != null && same(o['callback_token_sha256'], h))) throw pgError('23505', 'duplicate callback_token_sha256 (global unique)');
    }
  }
  function exec(text: string, values: readonly unknown[]): Row[] {
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
      const done: Row[] = [];
      for (const r of hit) { const next: Row = { ...r }; applySet(next, m[1]!, values); checks(table, next, r); Object.assign(r, next); done.push(r); }
      return /\breturning\b/i.test(text) ? done.map((r) => ({ ...r })) : [];
    }
    if (verb === 'insert') {
      const m = /into\s+reporting\.\w+\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b([\s\S]*?))?(?:\breturning\b[\s\S]*)?$/i.exec(text);
      if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: INSERT must be `INSERT INTO reporting.t (cols) VALUES ($1, ...)`');
      const cols = m[1]!.split(',').map((c) => c.trim()); const out: Row[] = [];
      for (const g of topLevelGroups(m[2]!)) {
        const toks = splitComma(g); const row: Row = { ...DEFAULTS[table] };
        cols.forEach((c, i) => { const t = toks[i]!; if (/^default$/i.test(t)) return; row[c] = parse(c, tokenValue(t, values)); });
        if (row['id'] === undefined && table !== 'g_message_templates') row['id'] = idN(++idSeq);
        if (table !== 'g_message_templates' && (row['tenant_id'] === undefined || row['tenant_id'] === null)) throw pgError('23502', 'null tenant_id');
        const dup = rows.find((e) => (UNIQUE[table] ?? []).some((u) => u.every((c) => same(e[c], row[c]))));
        if (dup) {
          if (!m[3]) throw pgError('23505', 'duplicate key');
          if (/do\s+nothing/i.test(m[3])) continue;
          const upd = /do\s+update\s+set([\s\S]*)$/i.exec(m[3])?.[1] ?? ''; const w = /\bwhere\b([\s\S]*)$/i.exec(upd)?.[1];
          if (w && !matches(dup, eqFilters(w, values))) continue;           // DO UPDATE ... WHERE false -> no row returned (optimistic-lock miss)
          const next: Row = { ...dup }; applySet(next, upd.replace(/\bwhere\b[\s\S]*$/i, ''), values, row); checks(table, next, dup); Object.assign(dup, next); out.push({ ...dup });
        } else { checks(table, row); rows.push(row); out.push({ ...row }); }
      }
      return /\breturning\b/i.test(text) ? out : [];
    }
    return [];
  }
  const tx: any = {
    startedAt: new Date(NOW),
    async query(text: string, values: unknown[] = []) { stmts.push({ text, values: [...values], verb: (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase() }); return { rows: exec(text, values) }; },
    savepoint: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  return {
    tx, store, stmts,
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(s.verb)),
    idemStmts: () => stmts.filter((s) => /idempotency_keys/i.test(s.text)),
    texts: (tenant = TENANT_A) => store['message_template_texts']!.filter((r) => r['tenant_id'] === tenant),
    text: (id: string) => store['message_template_texts']!.find((r) => r['id'] === id)!,
    acct: (id: string) => store['channel_accounts']!.find((r) => r['id'] === id)!,
    accts: (tenant = TENANT_A) => store['channel_accounts']!.filter((r) => r['tenant_id'] === tenant),
  };
}
export type MsgDb = ReturnType<typeof makeMsgDb>;

// ------------------------------------------------------------------------------------------------ the world
export function makeMsgWorld(manifest: any, o: { seed?: Record<string, Row[]>; ctx?: Record<string, unknown> } = {}) {
  const db = makeMsgDb(o.seed ?? seedAll());
  const logs: unknown[] = []; const access: Row[] = []; const metrics: Array<{ name: string; labels: any }> = [];
  const noop = (sink: unknown[]) => (x: unknown) => { sink.push(x); };
  const ctxBase = {
    tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, tx: db.tx, now: () => NOW, ports: {},
    audit: { access: async (e: Row) => { access.push(e); } },
    log: { info: noop(logs), warn: noop(logs), error: noop(logs) },
    metrics: { inc: (name: string, labels?: any) => metrics.push({ name, labels: labels ?? {} }) },
    clientIp: '203.0.113.9', manifest, ...o.ctx,
  };
  const run = (op: string, req: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}, over: Record<string, unknown> = {}) =>
    manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, { ...ctxBase, operationId: op, ...over });
  /** Everything that could leak a secret: every statement (text + bound values), logs, audit entries, metric labels. */
  const everything = () => JSON.stringify({ stmts: db.stmts.map((s) => [s.text, s.values]), logs, access, metrics });
  return { db, logs, access, metrics, run, everything, ctxBase };
}
export type MsgWorld = ReturnType<typeof makeMsgWorld>;
