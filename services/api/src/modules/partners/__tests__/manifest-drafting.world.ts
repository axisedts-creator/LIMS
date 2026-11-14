// C13 T08 test world: in-memory SQL subset + handler context for manifest drafting (M1-M7, M10, P2). Synthetic data only. NOT a test file.
// The fake interprets ONLY single-table statements (the writer follows this seam or raises a dispute; anything else throws "fake SQL cannot ...").
//   SELECT <cols | * | col AS alias | [COALESCE(]MAX|MIN|COUNT(col|*)[, 0)][::int] AS alias> FROM partners.<table> [alias]
//          [WHERE <AND/OR/parens of: col =|<>|!=|<|>|<=|>= expr | col IS [NOT] NULL | col = ANY($n[::t[]]) | col IN (…) | [lower(]col[)] [NOT] [I]LIKE expr
//                  | (a, b) <|> (expr, expr)>] [ORDER BY col [ASC|DESC][, …]] [LIMIT $n|n] [FOR UPDATE]
//          tables: partners.{partners, settings, manifests, manifest_lines, manifest_counters, price_list_items, partner_referrers}
//   INSERT INTO partners.{manifests, manifest_lines} (cols) VALUES (exprs) [RETURNING …]            -- CHECKs, NOT NULLs, UNIQUEs, FKs of 05-SCHEMA enforced (pg error codes)
//   INSERT INTO partners.manifest_counters (…) VALUES (…) ON CONFLICT (tenant_id, partner_id, yy) DO UPDATE SET last_seq = <anything> + 1 … RETURNING last_seq   -- atomic
//   UPDATE partners.{manifests, manifest_lines} [alias] SET col = $n | 'lit' | NULL | now() | col + n | col - n [, …] WHERE <as above> [RETURNING …]
//   DELETE FROM partners.manifest_lines WHERE <as above> [RETURNING …]
//   expr = $n[::type] | 'lit' | NULL | now() | true | false | number. Each query() yields once first, so concurrent handlers interleave between statements.
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export const id = (n: number) => `01940e00-0000-7000-8000-c1308${String(n).padStart(7, '0')}`;
export const T_A = id(1), T_B = id(2);
export const STAFF = id(3);
export const BR = { a1: id(10), a2: id(11), b1: id(12) };
export const CE = { a1: id(20), a2: id(21), b1: id(22) };
export const P = { x: id(40), y: id(41), s: id(42), b: id(43) };
export const OR = { glu: id(100), cbc: id(101), tsh: id(102), a1c: id(103), bx: id(104), none: id(199) }; // glu/cbc partner X; tsh standard (X); a1c partner Y; bx tenant B
export const RF = { x1: id(110), x2inactive: id(111), y1: id(112), b1: id(113) };
export const M = { x1: id(120), x2: id(121), xs: id(122), y1: id(123), b1: id(124) };
export const L = { x1: id(130), xs: id(131), y1: id(132), b1: id(133) };
/** who = key of USERS. actor.id (identity id) is what created_by/updated_by must carry. */
export const USERS = {
  x1: { puId: id(50), membership: id(60), actor: id(70), partner: P.x, tenant: T_A, role: 'partner_member', status: 'active', name: 'Synthetic User X1' },
  x2: { puId: id(51), membership: id(61), actor: id(71), partner: P.x, tenant: T_A, role: 'partner_admin', status: 'active', name: 'Synthetic User X2' },
  y1: { puId: id(52), membership: id(62), actor: id(72), partner: P.y, tenant: T_A, role: 'partner_member', status: 'active', name: 'Synthetic User Y1' },
  s1: { puId: id(53), membership: id(63), actor: id(73), partner: P.s, tenant: T_A, role: 'partner_member', status: 'active', name: 'Synthetic User S1' },
  b1: { puId: id(54), membership: id(64), actor: id(74), partner: P.b, tenant: T_B, role: 'partner_member', status: 'active', name: 'Synthetic User B1' },
} as const;
export type Who = keyof typeof USERS | 'staff';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const NOW0 = '2026-11-13T00:00:00.000Z';
export const PARTNER_PERMS = ['partners.order.read', 'partners.report.read', 'partners.manifest.submit', 'partners.price_list.read', 'partners.referrer.read'];

const pgErr = (code: string, constraint: string, message: string) => Object.assign(new Error(message), { code, constraint, detail: message });
const MANIFEST_COLS = ['id', 'tenant_id', 'partner_id', 'manifest_no', 'state', 'receiving_branch_id', 'receiving_centre_id', 'conversion_mode', 'notes', 'collected_on', 'line_count', 'submitted_at',
  'submitted_by', 'received_at', 'received_by', 'in_transit_at', 'withdrawn_at', 'withdrawn_by', 'withdraw_reason_code', 'withdraw_reason_text', 'discarded_at', 'version', 'is_active', 'created_at',
  'created_by', 'updated_at', 'updated_by'];
const LINE_COLS = ['id', 'tenant_id', 'partner_id', 'manifest_id', 'receiving_centre_id', 'line_no', 'state', 'partner_sample_ref', 'patient_full_name', 'patient_sex', 'patient_birth_on', 'patient_age_years',
  'patient_phone_e164', 'consent_attested', 'consent_sms', 'consent_whatsapp', 'consent_email', 'consent_share_with_referrer', 'consent_text_version', 'orderable_ids', 'orderables_snapshot', 'priority',
  'referrer_id', 'collected_at', 'clinical_note', 'resolved_patient_id', 'conversion_attempt', 'order_id', 'registration_no', 'converted_at', 'failure_code', 'failed_at', 'sample_received_at', 'received_by',
  'sample_missing', 'not_received_reason_code', 'is_redacted', 'redacted_at', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const COUNTER_COLS = ['tenant_id', 'partner_id', 'yy', 'last_seq', 'created_at', 'created_by', 'updated_at', 'updated_by'];
/** columns a partner (draft or not) must never write: 05-SCHEMA guard_partner_columns -> immutable_row (07-SECURITY AB11). */
const GUARDED: Record<string, string[]> = {
  'partners.manifest_lines': ['order_id', 'registration_no', 'converted_at', 'failure_code', 'failed_at', 'sample_received_at', 'received_by', 'sample_missing', 'not_received_reason_code', 'resolved_patient_id', 'conversion_attempt'],
  'partners.manifests': ['received_at', 'received_by', 'in_transit_at'],
};
const JSON_COLS = new Set(['orderables_snapshot']);
const toStored = (col: string, v: unknown) => (/_at$/.test(col) && typeof v === 'string' ? new Date(v) : JSON_COLS.has(col) && typeof v === 'string' ? JSON.parse(v) : v);

function balancedEnd(s: string, open: number): number {
  let depth = 0, q = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return i;
  }
  throw new Error(`unbalanced parens in: ${s}`);
}
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (const c of s) {
    if (c === "'") q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') depth--;
    if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function splitBool(s: string, kw: 'AND' | 'OR'): string[] {
  const out: string[] = []; const re = new RegExp(`^\\s+${kw}\\s+`, 'i'); let depth = 0, q = false, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /\s/.test(c)) { const m = re.exec(s.slice(i)); if (m) { out.push(s.slice(last, i)); i += m[0].length - 1; last = i + 1; } }
  }
  out.push(s.slice(last)); return out;
}
/** Row locks (SELECT ... FOR UPDATE, UPDATE, DELETE, counter upsert) are held until the handler settles (tests call releaseLocks(ctx.tx) from `call`). Others wait (READ COMMITTED), then re-evaluate. */
const locks = new Map<Row, object>();
export const releaseLocks = (tx: object) => { for (const [r, h] of locks) if (h === tx) locks.delete(r); };
async function waitFree(tx: object, pick: () => Row[]): Promise<Row[]> {
  for (let n = 0; ; n++) {
    const hit = pick();
    // C13.T10 ruling: free-check and acquire in one synchronous step (no await between), and `pick()` is re-run on every wait loop = READ COMMITTED WHERE re-check.
    if (!hit.some((r) => { const h = locks.get(r); return h !== undefined && h !== tx; })) { for (const r of hit) locks.set(r, tx); return hit; }
    if (n > 20000) throw new Error('fake lock wait timeout (deadlock?)');
    await Promise.resolve();
  }
}
const cmpVal = (v: unknown) => (v instanceof Date ? v.getTime() : v);

export function makeWorld() {
  const w = {
    now: NOW0,
    partners: [] as Row[], settings: new Map<string, Row>(), manifests: [] as Row[], lines: [] as Row[], counters: [] as Row[], prices: [] as Row[], referrers: [] as Row[],
    jobs: [] as unknown[], log: [] as Array<{ text: string; values: unknown[] }>,
    get writes() { return w.log.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text)); },
    get linesOf() { return (mid: string) => w.lines.filter((l) => l['manifest_id'] === mid).sort((a, b) => a['line_no'] - b['line_no']); },
    snapshot: () => JSON.stringify([w.manifests, w.lines, w.counters]),
    setSettings(t: string, patch: Row | null) { if (patch === null) w.settings.delete(t); else w.settings.set(t, { ...w.settings.get(t), ...patch }); },
    reset() { w.manifests.length = 0; w.lines.length = 0; w.counters.length = 0; },
    mkManifest(over: Row = {}): Row {
      const p = w.partners.find((z) => z['id'] === (over['partner_id'] ?? P.x))!;
      const state = over['state'] ?? 'draft';
      const r: Row = { id: id(900 + w.manifests.length), tenant_id: p['tenant_id'], partner_id: p['id'], manifest_no: `MF26${String(900000 + w.manifests.length)}`, state, receiving_branch_id: p['receiving_branch_id'],
        receiving_centre_id: p['receiving_centre_id'], conversion_mode: p['conversion_mode'], notes: null, collected_on: null, line_count: 0, submitted_at: ['draft', 'discarded'].includes(state) ? null : new Date('2026-11-05T00:00:00Z'),
        submitted_by: null, received_at: null, received_by: null, in_transit_at: null, withdrawn_at: state === 'withdrawn' ? new Date('2026-11-06T00:00:00Z') : null, withdrawn_by: null,
        withdraw_reason_code: state === 'withdrawn' ? 'other' : null, withdraw_reason_text: null, discarded_at: state === 'discarded' ? new Date('2026-11-06T00:00:00Z') : null, version: 1, is_active: true,
        created_at: new Date('2026-11-04T00:00:00Z'), created_by: USERS.x1.actor, updated_at: new Date('2026-11-04T00:00:00Z'), updated_by: USERS.x1.actor, ...over };
      w.manifests.push(r); return r;
    },
    mkLine(mid: string, over: Row = {}): Row {
      const m = w.manifests.find((z) => z['id'] === mid)!; const n = w.lines.filter((l) => l['manifest_id'] === mid).length + 1;
      const r: Row = { id: id(5000 + w.lines.length), tenant_id: m['tenant_id'], partner_id: m['partner_id'], manifest_id: mid, receiving_centre_id: m['receiving_centre_id'], line_no: n, state: 'draft',
        partner_sample_ref: null, patient_full_name: `Synthetic Patient ${n}`, patient_sex: 'female', patient_birth_on: null, patient_age_years: 30, patient_phone_e164: null, consent_attested: true,
        consent_sms: false, consent_whatsapp: false, consent_email: false, consent_share_with_referrer: false, consent_text_version: 'partner-v1', orderable_ids: [OR.glu],
        orderables_snapshot: [{ orderable_id: OR.glu, kind: 'test', code: 'GLU', name: 'Glucose Fasting' }], priority: 'routine', referrer_id: null, collected_at: null, clinical_note: null,
        resolved_patient_id: null, conversion_attempt: 0, order_id: null, registration_no: null, converted_at: null, failure_code: null, failed_at: null, sample_received_at: null, received_by: null,
        sample_missing: false, not_received_reason_code: null, is_redacted: false, redacted_at: null, version: 1, is_active: true, created_at: new Date('2026-11-04T00:00:00Z'), created_by: USERS.x1.actor,
        updated_at: new Date('2026-11-04T00:00:00Z'), updated_by: USERS.x1.actor, ...over };
      w.lines.push(r); return r;
    },
    tables(): Record<string, Row[]> {
      return { 'partners.partners': w.partners, 'partners.manifests': w.manifests, 'partners.manifest_lines': w.lines, 'partners.manifest_counters': w.counters, 'partners.price_list_items': w.prices,
        'partners.partner_referrers': w.referrers, 'partners.settings': [...w.settings.entries()].map(([t, s]) => ({ tenant_id: t, ...s })) };
    },

    // ---- constraint checks (05-SCHEMA §3.x) ----
    checkManifest(r: Row, op: string) {
      const bad = (c: string) => pgErr('23514', c, `${op}: manifests check ${c}`);
      for (const c of Object.keys(r)) if (!MANIFEST_COLS.includes(c)) throw pgErr('42703', c, `column ${c} does not exist`);
      for (const c of ['id', 'tenant_id', 'partner_id', 'manifest_no', 'receiving_branch_id', 'receiving_centre_id', 'conversion_mode', 'created_by', 'updated_by']) if (r[c] == null) throw pgErr('23502', c, `${op}: ${c} null`);
      if (!/^MF[0-9]{8}$/.test(r['manifest_no'])) throw bad('manifests__no__ck');
      if (!['draft', 'submitted', 'partially_received', 'received', 'withdrawn', 'discarded'].includes(r['state'])) throw bad('manifests__state__ck');
      if (!['on_receipt', 'on_submit'].includes(r['conversion_mode'])) throw bad('manifests__mode__ck');
      if (r['notes'] != null && String(r['notes']).length > 500) throw bad('manifests__notes__ck');
      if (!(r['line_count'] >= 0 && r['line_count'] <= 200)) throw bad('manifests__lines__ck');
      if ((['draft', 'discarded'].includes(r['state'])) !== (r['submitted_at'] == null)) throw bad('manifests__submitted__ck');
      if ((r['state'] === 'discarded') !== (r['discarded_at'] != null)) throw bad('manifests__discarded__ck');
      if ((r['state'] === 'withdrawn') !== (r['withdrawn_at'] != null && r['withdraw_reason_code'] != null)) throw bad('manifests__withdrawn__ck');
      if (!w.partners.some((p) => p['tenant_id'] === r['tenant_id'] && p['id'] === r['partner_id'])) throw pgErr('23503', 'manifests__partner__fk', 'partner fk');
    },
    checkLine(r: Row, op: string) {
      const bad = (c: string) => pgErr('23514', c, `${op}: manifest_lines check ${c}`);
      for (const c of Object.keys(r)) if (!LINE_COLS.includes(c)) throw pgErr('42703', c, `column ${c} does not exist`);
      for (const c of ['id', 'tenant_id', 'partner_id', 'manifest_id', 'receiving_centre_id', 'line_no', 'consent_text_version', 'orderable_ids', 'orderables_snapshot', 'priority', 'consent_attested', 'created_by', 'updated_by'])
        if (r[c] == null) throw pgErr('23502', c, `${op}: ${c} null`);
      if (!(r['line_no'] >= 1 && r['line_no'] <= 200)) throw bad('manifest_lines__line_no__ck');
      if (!['draft', 'submitted', 'converting', 'converted', 'conversion_failed', 'not_received', 'withdrawn', 'discarded', 'cancelled'].includes(r['state'])) throw bad('manifest_lines__state__ck');
      if (r['partner_sample_ref'] != null && !/^[A-Za-z0-9_./-]{1,40}$/.test(r['partner_sample_ref'])) throw bad('manifest_lines__ref__ck');
      if (r['patient_full_name'] != null && !(r['patient_full_name'].length >= 1 && r['patient_full_name'].length <= 120)) throw bad('manifest_lines__name__ck');
      if (r['patient_sex'] != null && !['male', 'female', 'other', 'unknown'].includes(r['patient_sex'])) throw bad('manifest_lines__sex__ck');
      if (r['patient_birth_on'] != null && String(r['patient_birth_on']) < '1900-01-01') throw bad('manifest_lines__dob__ck');
      if (r['patient_age_years'] != null && !(r['patient_age_years'] >= 0 && r['patient_age_years'] <= 130)) throw bad('manifest_lines__age__ck');
      if (r['patient_phone_e164'] != null && !/^\+[1-9][0-9]{7,14}$/.test(r['patient_phone_e164'])) throw bad('manifest_lines__phone__ck');
      if (!r['is_redacted'] && !(r['patient_full_name'] != null && r['patient_sex'] != null && ((r['patient_birth_on'] == null) !== (r['patient_age_years'] == null)) && r['consent_attested'])) throw bad('manifest_lines__patient__ck');
      if (!(r['consent_text_version'].length >= 1 && r['consent_text_version'].length <= 32)) throw bad('manifest_lines__consent_ver__ck');
      if (!Array.isArray(r['orderable_ids']) || r['orderable_ids'].length < 1 || r['orderable_ids'].length > 30) throw bad('manifest_lines__orderables__ck');
      if (!Array.isArray(r['orderables_snapshot'])) throw bad('manifest_lines__snapshot__ck');
      if (!['routine', 'urgent'].includes(r['priority'])) throw bad('manifest_lines__priority__ck');
      if (r['clinical_note'] != null && r['clinical_note'].length > 300) throw bad('manifest_lines__note__ck');
      const m = w.manifests.find((z) => z['tenant_id'] === r['tenant_id'] && z['id'] === r['manifest_id']);
      if (!m || m['partner_id'] !== r['partner_id']) throw pgErr('23503', 'manifest_lines__manifest__fk', 'manifest fk');
      if (r['referrer_id'] != null && !w.referrers.some((f) => f['tenant_id'] === r['tenant_id'] && f['id'] === r['referrer_id'] && f['partner_id'] === r['partner_id'])) throw pgErr('23503', 'manifest_lines__referrer__fk', 'referrer fk');
    },
    uniques(table: string, r: Row, self?: Row) {
      const others = (table === 'partners.manifests' ? w.manifests : w.lines).filter((o) => o !== self);
      if (others.some((o) => o['id'] === r['id'])) throw pgErr('23505', `${table.split('.')[1]}__pk`, 'duplicate id');
      if (table === 'partners.manifests' && others.some((o) => o['tenant_id'] === r['tenant_id'] && o['partner_id'] === r['partner_id'] && o['manifest_no'] === r['manifest_no']))
        throw pgErr('23505', 'manifests__tenant_id_partner_id_no__uq', 'duplicate manifest_no');
      if (table === 'partners.manifest_lines') {
        if (others.some((o) => o['tenant_id'] === r['tenant_id'] && o['manifest_id'] === r['manifest_id'] && o['line_no'] === r['line_no'])) throw pgErr('23505', 'manifest_lines__tenant_id_manifest_id_line_no__uq', 'duplicate line_no');
        if (r['partner_sample_ref'] != null && others.some((o) => o['tenant_id'] === r['tenant_id'] && o['manifest_id'] === r['manifest_id'] && o['partner_sample_ref'] === r['partner_sample_ref']))
          throw pgErr('23505', 'manifest_lines__tenant_id_manifest_id_ref__p_uq', 'duplicate partner_sample_ref');
      }
    },
    guard(table: string, cols: string[], values: Row) {
      for (const c of cols) if (GUARDED[table]?.includes(c) && values[c] != null && values[c] !== false && values[c] !== 0) throw pgErr('55000', 'guard_partner_columns', `immutable_row: ${c}`);
    },

    // ---- expression / WHERE evaluation ----
    ev(e: string, vals: unknown[], row?: Row): unknown {
      const x = e.trim().replace(/::\w+(\[\])?/g, '').replace(/^\((.*)\)$/s, '$1').trim();
      let m: RegExpExecArray | null;
      if ((m = /^\$(\d+)$/.exec(x))) return vals[Number(m[1]) - 1];
      if ((m = /^'((?:[^']|'')*)'$/.exec(x))) return m[1]!.replace(/''/g, "'");
      if (/^NULL$/i.test(x)) return null;
      if (/^now\(\)$/i.test(x)) return new Date(w.now);
      if (/^true$/i.test(x)) return true;
      if (/^false$/i.test(x)) return false;
      if (/^-?\d+$/.test(x)) return Number(x);
      if ((m = /^(?:[\w.]+\.)?(\w+)\s*([+-])\s*(\d+)$/.exec(x)) && row) return Number(row[m[1]!]) + (m[2] === '+' ? 1 : -1) * Number(m[3]);
      throw new Error(`fake SQL cannot evaluate expression: ${e}`);
    },
    test(row: Row, clause: string, vals: unknown[]): boolean {
      let s = clause.trim();
      while (s.startsWith('(') && balancedEnd(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
      const ors = splitBool(s, 'OR'); if (ors.length > 1) return ors.some((t) => w.test(row, t, vals));
      const ands = splitBool(s, 'AND'); if (ands.length > 1) return ands.every((t) => w.test(row, t, vals));
      let m: RegExpExecArray | null;
      if (/^1\s*=\s*1$/.test(s)) return true;
      if ((m = /^(?:\w+\.)?(\w+)\s+IS\s+(NOT\s+)?NULL$/i.exec(s))) return m[2] ? row[m[1]!] != null : row[m[1]!] == null;
      if ((m = /^(?:\w+\.)?(\w+)\s*=\s*ANY\s*\(\s*\$(\d+)(?:::\w+\[\])?\s*\)$/i.exec(s))) return (vals[Number(m[2]) - 1] as unknown[]).includes(row[m[1]!]);
      if ((m = /^(?:\w+\.)?(\w+)\s+IN\s*\(([^)]*)\)$/i.exec(s))) return splitTop(m[2]!).map((x) => w.ev(x, vals)).includes(row[m[1]!]);
      if ((m = /^\(\s*(?:\w+\.)?(\w+)\s*,\s*(?:\w+\.)?(\w+)\s*\)\s*(<|>)\s*\(([^)]*)\)$/.exec(s))) {
        const [a, b] = splitTop(m[4]!).map((x) => cmpVal(/_at$/.test(m![1]!) ? new Date(String(w.ev(x, vals))) : w.ev(x, vals)));
        const l1 = cmpVal(row[m[1]!]) as any, l2 = cmpVal(row[m[2]!]) as any;
        return m[3] === '<' ? l1 < (a as any) || (l1 === a && l2 < (b as any)) : l1 > (a as any) || (l1 === a && l2 > (b as any));
      }
      if ((m = /^(?:lower\(\s*)?(?:\w+\.)?(\w+)\s*\)?\s+(NOT\s+)?I?LIKE\s+(.+)$/i.exec(s))) {
        const pat = String(w.ev(m[3]!, vals)); const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'is');
        const hit = re.test(String(row[m[1]!] ?? '')); return m[2] ? !hit : hit;
      }
      if ((m = /^(?:\w+\.)?(\w+)\s*(<>|!=|<=|>=|=|<|>)\s*(.+)$/.exec(s))) {
        const col = m[1]!; let v = w.ev(m[3]!, vals, row);
        if (/_at$/.test(col) && typeof v === 'string') v = new Date(v);
        const a = cmpVal(row[col]) as any, b = cmpVal(v) as any;
        return m[2] === '=' ? a === b : m[2] === '<>' || m[2] === '!=' ? a !== b : m[2] === '<' ? a < b : m[2] === '>' ? a > b : m[2] === '<=' ? a <= b : a >= b;
      }
      throw new Error(`fake SQL cannot evaluate WHERE term: ${s}`);
    },
    where(rows: Row[], text: string, vals: unknown[]): Row[] {
      const wm = /\bWHERE\b([\s\S]*?)(?:\s+(?:ORDER\s+BY|LIMIT|FOR\s+UPDATE|RETURNING)\b[\s\S]*)?$/i.exec(text);
      return wm ? rows.filter((r) => w.test(r, wm[1]!, vals)) : [...rows];
    },
    newTx() {
      const tx: any = {
        startedAt: new Date(w.now), operation: {}, savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
        async query(text: string, vals: unknown[] = []) {
          await Promise.resolve();
          w.log.push({ text, values: [...vals] });
          if (/app\.enqueue_job/i.test(text)) { w.jobs.push({ text, vals }); return { rows: [], rowCount: 1 }; }
          if (/\bmembership_id\b/i.test(text) && /\bFROM\s+partners\.partner_users\b/i.test(text)) { // T03 partnerContext lookup (no RLS here: the handlers must scope by ctx.partner themselves)
            const u = Object.values(USERS).find((z) => vals.includes(z.tenant) && vals.includes(z.membership));
            const p = u && w.partners.find((z) => z['tenant_id'] === u.tenant && z['id'] === u.partner); const s = u && w.settings.get(u.tenant);
            return { rows: u && p ? [{ partner_user_id: u.puId, partner_id: u.partner, partner_role: u.role, user_status: u.status, partner_status: p['status'], display_name: u.name, partner_code: p['partner_code'],
              partner_name: p['name'], conversion_mode: p['conversion_mode'], access_slip_enabled: s?.['access_slip_enabled'] ?? null, include_default_price_list: s?.['include_default_price_list'] ?? null }] : [] };
          }
          let m: RegExpExecArray | null;
          if (/^\s*INSERT\s+INTO\s+partners\.manifest_counters\b/i.test(text)) {
            const cols = splitTop(/\(([^)]*)\)\s*VALUES/is.exec(text)![1]!); const v0 = text.search(/VALUES\s*\(/i); const exprs = splitTop(text.slice(text.indexOf('(', v0) + 1, balancedEnd(text, text.indexOf('(', v0))));
            const r: Row = {}; cols.forEach((c, i) => { r[c.trim()] = w.ev(exprs[i]!, vals); });
            for (const c of Object.keys(r)) if (!COUNTER_COLS.includes(c)) throw pgErr('42703', c, `column ${c} does not exist`);
            if (!/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*partner_id\s*,\s*yy\s*\)\s*DO\s+UPDATE\s+SET\s+last_seq\s*=[^,]*\+\s*1/i.test(text)) throw new Error(`fake SQL: counter allocation must be one atomic upsert: ${text}`);
            if (!w.partners.some((p) => p['tenant_id'] === r['tenant_id'] && p['id'] === r['partner_id'])) throw pgErr('23503', 'manifest_counters__partner__fk', 'partner fk');
            const hit = w.counters.find((c) => c['tenant_id'] === r['tenant_id'] && c['partner_id'] === r['partner_id'] && Number(c['yy']) === Number(r['yy']));
            if (hit) { await waitFree(tx, () => [hit]); locks.set(hit, tx); hit['last_seq'] += 1; if (hit['last_seq'] > 999999) throw pgErr('23514', 'manifest_counters__seq__ck', 'seq'); return { rows: [{ ...hit }], rowCount: 1 }; }
            if (!(r['yy'] >= 0 && r['yy'] <= 99 && r['last_seq'] >= 1 && r['last_seq'] <= 999999)) throw pgErr('23514', 'manifest_counters__ck', 'counter check');
            const row = { ...r, yy: Number(r['yy']) }; w.counters.push(row); locks.set(row, tx); return { rows: [{ ...row }], rowCount: 1 };
          }
          if ((m = /^\s*INSERT\s+INTO\s+(partners\.manifests|partners\.manifest_lines)\s*\(([^)]*)\)\s*VALUES\s*\(/i.exec(text))) {
            const table = m[1]!.toLowerCase(); const cols = splitTop(m[2]!); const open = m[0].length - 1; const exprs = splitTop(text.slice(open + 1, balancedEnd(text, open)));
            if (cols.length !== exprs.length) throw new Error('fake SQL: column/value count mismatch');
            const row: Row = {}; const given: Row = {};
            cols.forEach((c, i) => { given[c] = toStored(c, w.ev(exprs[i]!, vals)); });
            w.guard(table, cols, given);
            const base = table === 'partners.manifests' ? { state: 'draft', line_count: 0, version: 1, is_active: true, created_at: new Date(w.now), updated_at: new Date(w.now) }
              : { state: 'draft', consent_sms: false, consent_whatsapp: false, consent_email: false, consent_share_with_referrer: false, conversion_attempt: 0, sample_missing: false, is_redacted: false, version: 1, is_active: true, created_at: new Date(w.now), updated_at: new Date(w.now) };
            for (const c of table === 'partners.manifests' ? MANIFEST_COLS : LINE_COLS) row[c] = (base as Row)[c] ?? null;
            Object.assign(row, given);
            if (table === 'partners.manifests') w.checkManifest(row, 'INSERT'); else w.checkLine(row, 'INSERT');
            w.uniques(table, row);
            (table === 'partners.manifests' ? w.manifests : w.lines).push(row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if ((m = /^\s*UPDATE\s+(partners\.manifests|partners\.manifest_lines)\s+(?:AS\s+)?(?:(?!SET\b)\w+\s+)?SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i.exec(text))) {
            const table = m[1]!.toLowerCase(); const rows = table === 'partners.manifests' ? w.manifests : w.lines;
            const sets = splitTop(m[2]!).map((s) => { const mm = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(s); if (!mm) throw new Error(`fake SQL cannot parse SET: ${s}`); return [mm[1]!, mm[2]!] as const; });
            const hit = await waitFree(tx, () => w.where(rows, `WHERE ${m[3]}`, vals)); const out: Row[] = []; for (const r of hit) locks.set(r, tx);
            for (const r of hit) {
              const next = { ...r }; const given: Row = {};
              for (const [c, e] of sets) { next[c] = toStored(c, w.ev(e, vals, r)); given[c] = next[c]; }
              w.guard(table, sets.map(([c]) => c), given);
              if (table === 'partners.manifests') w.checkManifest(next, 'UPDATE'); else w.checkLine(next, 'UPDATE');
              w.uniques(table, next, r); Object.assign(r, next); out.push({ ...r });
            }
            return { rows: out, rowCount: out.length };
          }
          if ((m = /^\s*DELETE\s+FROM\s+partners\.manifest_lines\b/i.exec(text))) {
            const hit = await waitFree(tx, () => w.where(w.lines, text, vals)); for (const r of hit) w.lines.splice(w.lines.indexOf(r), 1);
            return { rows: hit.map((r) => ({ ...r })), rowCount: hit.length };
          }
          if ((m = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s+(partners\.\w+)\b/i.exec(text))) {
            const rows = w.tables()[m[2]!.toLowerCase()]; if (!rows) throw new Error(`fake SQL: unknown table ${m[2]}`);
            if (/\bJOIN\b/i.test(text)) throw new Error(`fake SQL: single-table statements only: ${text}`);
            const forUpdate = /\bFOR\s+UPDATE\b/i.test(text);
            let hit = forUpdate ? await waitFree(tx, () => w.where(rows, text, vals)) : w.where(rows, text, vals);
            if (forUpdate) for (const r of hit) locks.set(r, tx);
            const ob = /ORDER\s+BY\s+([\s\S]*?)(?:\s+(?:LIMIT|FOR\s+UPDATE)\b[\s\S]*)?$/i.exec(text);
            if (ob) {
              const keys = splitTop(ob[1]!).map((k) => { const km = /^(?:lower\(\s*)?(?:\w+\.)?(\w+)\)?(?:\s+(ASC|DESC))?(?:\s+NULLS\s+\w+)?$/i.exec(k); if (!km) throw new Error(`fake SQL cannot parse ORDER BY: ${k}`); return [km[1]!, /DESC/i.test(km[2] ?? '')] as const; });
              hit = [...hit].sort((a, b) => { for (const [k, desc] of keys) { const x = cmpVal(a[k]) as any, y = cmpVal(b[k]) as any; if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1); } return 0; });
            }
            const lim = /\bLIMIT\s+(?:\$(\d+)|(\d+))/i.exec(text); if (lim) hit = hit.slice(0, lim[1] ? Number(vals[Number(lim[1]) - 1]) : Number(lim[2]));
            const items = splitTop(m[1]!); const aggs = items.map((it) => /^(?:COALESCE\(\s*)?(count|max|min)\(\s*(\*|[\w.]+)\s*\)(?:\s*,\s*[^)]*\))?(::\w+)?\s+AS\s+(\w+)$/i.exec(it)).filter(Boolean) as RegExpExecArray[];
            if (aggs.length) {
              const o: Row = {};
              for (const a of aggs) {
                const fn = a[1]!.toLowerCase(); const col = a[2]!.replace(/^\w+\./, ''); const xs = hit.map((r) => r[col]).filter((v) => v != null);
                o[a[4]!] = fn === 'count' ? (a[3] ? hit.length : String(hit.length)) : xs.length ? (fn === 'max' ? Math.max(...xs) : Math.min(...xs)) : /COALESCE/i.test(a[0]!) ? 0 : null;
              }
              return { rows: [o], rowCount: 1 };
            }
            const aliases = items.map((it) => /^(?:\w+\.)?(\w+)(?:::\w+)?\s+AS\s+(\w+)$/i.exec(it)).filter(Boolean) as RegExpExecArray[];
            return { rows: hit.map((r) => { const o = { ...r }; for (const a of aliases) o[a[2]!] = r[a[1]!]; return o; }), rowCount: hit.length };
          }
          throw new Error(`unexpected SQL in manifest drafting: ${text}`);
        },
      };
      return tx;
    },
  };

  // ---- seed (synthetic) ----
  const partner = (pid: string, tenant: string, code: string, status: string, cp: string, br: string, ce: string, mode: string): Row => ({ id: pid, tenant_id: tenant, partner_code: code, name: `Synthetic Partner ${code}`, status, credit_party_id: cp,
    receiving_branch_id: br, receiving_centre_id: ce, conversion_mode: mode, version: 1 });
  w.partners.push(partner(P.x, T_A, 'SYN-X', 'active', id(30), BR.a1, CE.a1, 'on_receipt'), partner(P.y, T_A, 'SYN-Y', 'active', id(31), BR.a2, CE.a2, 'on_submit'),
    partner(P.s, T_A, 'SYN-S', 'suspended', id(32), BR.a1, CE.a1, 'on_receipt'), partner(P.b, T_B, 'SYN-B', 'active', id(33), BR.b1, CE.b1, 'on_receipt'));
  const set = (t: string) => ({ default_conversion_mode: 'on_receipt', include_default_price_list: true, require_mapped_referrer: false, access_slip_enabled: false, max_lines_per_manifest: 200, draft_ttl_days: 14,
    consent_text_version: 'partner-v1', consent_statement: 'Synthetic consent statement', version: 1, tenant_id: t });
  w.settings.set(T_A, set(T_A)); w.settings.set(T_B, set(T_B));
  const item = (t: string, p: string, o: string, kind: string, code: string, name: string, source: string): Row => ({ tenant_id: t, partner_id: p, orderable_id: o, kind, code, name, department_name: 'Synthetic Dept',
    unit_price_paisa: 150000, source, price_list_id: id(700), price_list_version: 3, effective_from: new Date('2026-01-01T00:00:00Z'), effective_to: null, synced_at: new Date('2026-11-12T00:00:00Z') });
  w.prices.push(item(T_A, P.x, OR.glu, 'test', 'GLU', 'Glucose Fasting', 'partner'), item(T_A, P.x, OR.cbc, 'panel', 'CBC', 'Complete Blood Count', 'partner'),
    item(T_A, P.x, OR.tsh, 'test', 'TSH', 'Thyroid Stimulating Hormone', 'standard'), item(T_A, P.y, OR.a1c, 'test', 'A1C', 'HbA1c Synthetic', 'partner'),
    item(T_B, P.b, OR.bx, 'test', 'BX1', 'Tenant B Only Test', 'partner'));
  const ref = (rid: string, t: string, p: string, name: string, active: boolean): Row => ({ id: rid, tenant_id: t, partner_id: p, display_name: name, is_active: active, mapping_state: 'unmapped', version: 1 });
  w.referrers.push(ref(RF.x1, T_A, P.x, 'Dr Synthetic One', true), ref(RF.x2inactive, T_A, P.x, 'Dr Synthetic Inactive', false), ref(RF.y1, T_A, P.y, 'Dr Synthetic Y', true), ref(RF.b1, T_B, P.b, 'Dr Synthetic B', true));
  w.counters.push({ tenant_id: T_A, partner_id: P.x, yy: 26, last_seq: 3, created_at: new Date(w.now), created_by: STAFF, updated_at: new Date(w.now), updated_by: STAFF },
    { tenant_id: T_A, partner_id: P.y, yy: 26, last_seq: 1, created_at: new Date(w.now), created_by: STAFF, updated_at: new Date(w.now), updated_by: STAFF },
    { tenant_id: T_B, partner_id: P.b, yy: 26, last_seq: 1, created_at: new Date(w.now), created_by: STAFF, updated_at: new Date(w.now), updated_by: STAFF });
  w.mkManifest({ id: M.x1, manifest_no: 'MF26000001', version: 3, line_count: 1, notes: 'Synthetic draft note', created_at: new Date('2026-11-01T00:00:00Z') });
  w.mkLine(M.x1, { id: L.x1, version: 2, partner_sample_ref: 'SYN-REF-1' });
  w.mkManifest({ id: M.x2, manifest_no: 'MF26000002', version: 1, line_count: 0, created_at: new Date('2026-11-02T00:00:00Z') });
  w.mkManifest({ id: M.xs, manifest_no: 'MF26000003', state: 'submitted', version: 4, line_count: 1, created_at: new Date('2026-11-03T00:00:00Z') });
  w.mkLine(M.xs, { id: L.xs, state: 'submitted', version: 2 });
  w.mkManifest({ id: M.y1, partner_id: P.y, manifest_no: 'MF26000001', version: 2, line_count: 1 });
  w.mkLine(M.y1, { id: L.y1, orderable_ids: [OR.a1c], orderables_snapshot: [{ orderable_id: OR.a1c, kind: 'test', code: 'A1C', name: 'HbA1c Synthetic' }], created_by: USERS.y1.actor, updated_by: USERS.y1.actor });
  w.mkManifest({ id: M.b1, partner_id: P.b, manifest_no: 'MF26000001', version: 2, line_count: 1 });
  w.mkLine(M.b1, { id: L.b1, orderable_ids: [OR.bx], orderables_snapshot: [{ orderable_id: OR.bx, kind: 'test', code: 'BX1', name: 'Tenant B Only Test' }] });
  return w;
}
export type World = ReturnType<typeof makeWorld>;

export interface Over { who?: Who; perms?: string[]; now?: string }
export function makeCtx(w: World, over: Over = {}) {
  const calls: string[] = []; const logs: string[] = []; const who = over.who ?? 'x1';
  const u = who === 'staff' ? undefined : USERS[who];
  const tenant = u?.tenant ?? T_A;
  const actor: any = u ? { type: 'partner', id: u.actor, membershipId: u.membership } : { type: 'user', id: STAFF, membershipId: id(90) };
  const perms = over.perms ?? (u ? PARTNER_PERMS : ['partners.partner.read', 'partners.partner.manage']);
  const nowIso = over.now ?? w.now; w.now = nowIso;
  const scoped = <T extends { id: string; tenant: string }>(list: T[], key: string) => list.find((x) => x.id === key && x.tenant === tenant);
  const centres = [{ id: CE.a1, tenant: T_A, branchId: BR.a1, code: 'CE-A1', name: 'Synthetic Centre A1' }, { id: CE.a2, tenant: T_A, branchId: BR.a2, code: 'CE-A2', name: 'Synthetic Centre A2' },
    { id: CE.b1, tenant: T_B, branchId: BR.b1, code: 'CE-B1', name: 'Synthetic Centre B1' }];
  const ctx: any = {
    tenantId: tenant, actor, requestId: id(98), tx: w.newTx(), now: () => nowIso,
    db: { async tx(fn: (c: unknown) => Promise<unknown>) { return fn(ctx); } },
    core: {
      async centre(_c: unknown, i: { centreId: string }) { calls.push('core.centre'); const c = scoped(centres, i.centreId); if (!c) throw new LimsError('common.not_found'); return { id: c.id, branchId: c.branchId, centreCode: c.code, name: c.name, centreKind: 'own', isActive: true }; },
      async centres() { calls.push('core.centres'); return centres.filter((c) => c.tenant === tenant).map((c) => ({ id: c.id, branchId: c.branchId, centreCode: c.code, name: c.name, centreKind: 'own', isActive: true })); },
      async tenant() { calls.push('core.tenant'); return { id: tenant, tenantCode: 'syn_lab', displayName: 'Synthetic Lab', legalName: 'x', status: 'active', timezone: 'Asia/Kathmandu' }; },
    },
    audit: { access: async () => undefined }, events: {}, uploads: {}, files: {}, storage: {}, services: {},
    log: { info: (o: object) => logs.push(JSON.stringify(o)), warn: (o: object) => logs.push(JSON.stringify(o)), error: (o: object) => logs.push(JSON.stringify(o)), debug: (o: object) => logs.push(JSON.stringify(o)) },
    ports: { IdentityPort: { async assertRole(_c: unknown, r: { permission: string }) { calls.push(`assertRole:${r.permission}`); if (!perms.includes(r.permission)) throw new LimsError('auth.forbidden'); } } },
  };
  return { ctx, calls, logs };
}
