// C13 T11 test fixture (not a test file): in-memory emulation of partners.partner_referrers / partners.manifest_lines / partners.partners over the
// `tx.query(text, values)` seam, plus IdentityPort / CatalogPort / partnerContext fakes. Synthetic data only.
// The fake parses the writer's SQL (SINGLE-TABLE statements, no JOIN, no sub-select) so the tests exercise the real WHERE clauses:
//   SELECT  : FROM partners.<table> [alias] WHERE <AND-conjunction; OR groups allowed> [GROUP BY col] [ORDER BY …] [LIMIT $n|n] [OFFSET $n|n] [FOR UPDATE]
//             atoms: col = $n | 'lit' | true | n ; <> != > >= < <= ; col = ANY($n) ; col [NOT] IN (…) ; col IS [NOT] NULL ;
//             [lower(]col[)] LIKE|ILIKE [lower(]$n[)] [ESCAPE '\'] (backslash escapes % _ \ in the param; LIKE is case-sensitive, ILIKE not).
//             count(*) [::int] [AS alias] (with GROUP BY col -> one row per group {col, alias}); a bare count() is a string like node-pg bigint, ::int is a number.
//   INSERT  : INSERT INTO partners.<table> (cols) VALUES (…) [ON CONFLICT … DO NOTHING] [RETURNING …] — values $n | 'lit' | NULL | now() | true/false | n.
//   UPDATE  : UPDATE partners.<table> [alias] SET col = $n | 'lit' | NULL | now() | true/false | n | col + 1, … WHERE … [RETURNING …].
//   SELECT app.enqueue_job(identifier, payload::jsonb, job_key[, …]) is recorded in w.jobs (same transaction as the rest: rolled back on error).
//   Constraints of 05-SCHEMA §3.3 / §3.5 are enforced (CHECKs, partial unique index on active referrers, mapped/rejected iff, failure_code iff conversion_failed).
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export const id = (n: number) => `01940e00-0000-7000-8000-c1311${String(n).padStart(7, '0')}`;
export const T_A = id(1), T_B = id(2);
export const P = { X: id(10), Y: id(11), Z: id(12), B: id(13) };
export const NOW = '2026-11-13T04:00:00.000Z';
export const UNIQUE_CONSTRAINT = 'partner_referrers__tenant_id_partner_id_name_regno__p_uq';

export type Who = 'adminX' | 'memberX' | 'adminY' | 'memberY' | 'adminZ' | 'adminB' | 'staff' | 'staffNoMap' | 'staffB';
export const U: Record<string, string> = { adminX: id(20), memberX: id(21), adminY: id(22), memberY: id(23), adminZ: id(24), adminB: id(25) };
export const M: Record<string, string> = { adminX: id(30), memberX: id(31), adminY: id(32), memberY: id(33), adminZ: id(34), adminB: id(35) };
export const STAFF = { id: id(50), membershipId: id(51) }, STAFF_NO_MAP = { id: id(52), membershipId: id(53) }, STAFF_B = { id: id(54), membershipId: id(55) };
export const R = { x1: id(60), x2: id(61), x3: id(62), x4: id(63), y1: id(64), b1: id(65) };
export const D = { d1: id(70), d2: id(71), inactive: id(72), merged: id(73), b: id(74), unknown: id(75) };
export const L = { f1: id(80), f2: id(81), f3: id(82), c1: id(83), f5: id(84), fy: id(85), fb: id(86), dr: id(87) };
export const NOT_MAPPED = 'partners.referrer_not_mapped', OTHER_FAILURE = 'frontdesk.patient_duplicate_suspected';

const ADMIN_PERMS = ['partners.referrer.read', 'partners.referrer.manage', 'partners.order.read'];
const MEMBER_PERMS = ['partners.referrer.read', 'partners.order.read'];
const pgErr = (code: string, message: string, constraint?: string) => Object.assign(new Error(message), { code, constraint });

export interface Opts {
  /** getReferrer throws this (infra failure) */
  catalogError?: unknown;
  /** enqueue_job throws this */
  enqueueError?: unknown;
  /** IdentityPort.getTenantSettings().timezone (default Asia/Kathmandu) */
  timezone?: string;
  /** ctx.now() (ISO string) */
  now?: string;
  /** a row (partial) that exists in the table but is invisible to SELECTs (a concurrent commit): only the unique index sees it */
  hiddenDuplicate?: Row;
  /** emulate a handler that forgets its own scoping: no RLS help */
  noRls?: boolean;
}

// ---------------------------------------------------------------- parsing helpers
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
function balancedEnd(s: string, open: number): number {
  let depth = 0, q = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return i;
  }
  throw new Error(`fake SQL: unbalanced parentheses in: ${s}`);
}
function splitTop(s: string, sep: 'AND' | 'OR' | ','): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0) {
      if (sep === ',' && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
      if (sep !== ',') {
        const m = new RegExp(`^\\s${sep}\\s`, 'i').exec(s.slice(i));
        if (m) { out.push(cur.trim()); cur = ''; i += m[0].length - 1; continue; }
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const unparen = (a: string) => { let x = a.trim(); while (x.startsWith('(') && balancedEnd(x, 0) === x.length - 1) x = x.slice(1, -1).trim(); return x; };
const tsCol = (c: string) => /_at$/.test(c);
function cmpNorm(v: unknown, col: string): string | number {
  if (v instanceof Date) return v.getTime();
  if (tsCol(col) && typeof v === 'string') return Date.parse(v);
  return String(v);
}
function likeRe(pattern: string, ci: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') { i++; re += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } else if (c === '%') re += '.*'; else if (c === '_') re += '.'; else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'is' : 's');
}

export function makeWorld() {
  const partners: Row[] = [
    { id: P.X, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active' },
    { id: P.Y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active' },
    { id: P.Z, tenant_id: T_A, partner_code: 'SYN-Z', name: 'Synthetic Partner Z', status: 'suspended' },
    { id: P.B, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active' },
  ];
  const mkUser = (k: string, tenant: string, partner: string, role: string, status = 'active') => ({ id: U[k], tenant_id: tenant, partner_id: partner, membership_id: M[k], partner_role: role, status });
  const users: Row[] = [
    mkUser('adminX', T_A, P.X, 'partner_admin'), mkUser('memberX', T_A, P.X, 'partner_member'), mkUser('adminY', T_A, P.Y, 'partner_admin'),
    mkUser('memberY', T_A, P.Y, 'partner_member'), mkUser('adminZ', T_A, P.Z, 'partner_admin'), mkUser('adminB', T_B, P.B, 'partner_admin'),
  ];
  const ref = (rid: string, tenant: string, partner: string, name: string, over: Row = {}): Row => ({
    id: rid, tenant_id: tenant, partner_id: partner, display_name: name, display_name_norm: name.toLowerCase(), qualification: null, registration_council: null, registration_no: null,
    mapping_state: 'unmapped', catalog_doctor_id: null, mapped_at: null, mapped_by: null, mapping_reject_reason_code: null, mapping_reject_text: null,
    version: 1, is_active: true, created_at: NOW, created_by: id(20), updated_at: NOW, updated_by: id(20), ...over,
  });
  const referrers: Row[] = [
    ref(R.x1, T_A, P.X, 'Dr Alpha Synthetic', { qualification: 'MBBS (synthetic)', registration_council: 'SYN-NMC', registration_no: 'SYN-0001' }),
    ref(R.x2, T_A, P.X, 'Dr Beta Synthetic', { registration_no: 'SYN-0002', mapping_state: 'mapped', catalog_doctor_id: D.d1, mapped_at: NOW, mapped_by: STAFF.id, version: 2 }),
    ref(R.x3, T_A, P.X, 'Dr Gamma Synthetic', { mapping_state: 'rejected', mapping_reject_reason_code: 'not_identifiable', version: 1 }),
    ref(R.x4, T_A, P.X, 'Dr Delta Synthetic', { is_active: false, version: 3 }),
    ref(R.y1, T_A, P.Y, 'Dr Alpha Synthetic', { registration_no: 'SYN-0001' }),
    ref(R.b1, T_B, P.B, 'Dr Epsilon Synthetic'),
  ];
  const line = (lid: string, partner: string, referrer: string | null, state: string, over: Row = {}): Row => ({
    id: lid, tenant_id: partner === P.B ? T_B : T_A, partner_id: partner, manifest_id: id(90), line_no: 1, state, referrer_id: referrer, conversion_attempt: 1,
    failure_code: state === 'conversion_failed' ? NOT_MAPPED : null, failed_at: state === 'conversion_failed' ? NOW : null, order_id: null, converted_at: null,
    version: 3, updated_at: NOW, ...over,
  });
  const lines: Row[] = [
    line(L.f1, P.X, R.x1, 'conversion_failed', { line_no: 1 }),
    line(L.f2, P.X, R.x1, 'conversion_failed', { line_no: 2, conversion_attempt: 2 }),
    line(L.f3, P.X, R.x1, 'conversion_failed', { line_no: 3, failure_code: OTHER_FAILURE }),
    line(L.c1, P.X, R.x1, 'converting', { line_no: 4 }),
    line(L.f5, P.X, R.x3, 'conversion_failed', { line_no: 5 }),
    line(L.fy, P.Y, R.y1, 'conversion_failed', { line_no: 1 }),
    line(L.fb, P.B, R.b1, 'conversion_failed', { line_no: 1 }),
    line(L.dr, P.X, R.x1, 'draft', { line_no: 6 }),
  ];
  const doctors = [
    { tenant: T_A, referrerId: D.d1, canonicalReferrerId: D.d1, code: 'SYN-DOC-1', displayName: 'Synthetic Doctor One', isVerified: true, isActive: true },
    { tenant: T_A, referrerId: D.d2, canonicalReferrerId: D.d2, code: 'SYN-DOC-2', displayName: 'Synthetic Doctor Two', isVerified: true, isActive: true },
    { tenant: T_A, referrerId: D.inactive, canonicalReferrerId: D.inactive, code: 'SYN-DOC-3', displayName: 'Synthetic Doctor Retired', isVerified: true, isActive: false },
    { tenant: T_A, referrerId: D.merged, canonicalReferrerId: D.d2, code: 'SYN-DOC-4', displayName: 'Synthetic Doctor Two (merged)', isVerified: false, isActive: true },
    { tenant: T_B, referrerId: D.b, canonicalReferrerId: D.b, code: 'SYN-DOC-B', displayName: 'Synthetic Doctor Other Tenant', isVerified: true, isActive: true },
  ];
  let seq = 400;
  const tables: Record<string, Row[]> = { partners, partner_referrers: referrers, manifest_lines: lines };
  /** partners.g_cs_reasons (05-SCHEMA §7): x-coded-set is annotation-only in core and the DDL has no CHECK/FK, so the service must validate SR3 reason_code (review item 1). */
  const reasons: Row[] = [
    { set_name: 'referrer_mapping_reject_reasons', code: 'not_identifiable', requires_text: false, is_active: true, sort_order: 1 },
    { set_name: 'referrer_mapping_reject_reasons', code: 'duplicate_entry', requires_text: false, is_active: true, sort_order: 2 },
    { set_name: 'referrer_mapping_reject_reasons', code: 'other', requires_text: false, is_active: true, sort_order: 3 },
  ];
  const w = {
    partners, users, referrers, lines, doctors, reasons,
    opts: {} as Opts,
    jobs: [] as Array<{ identifier: string; payload: any; key: string; extra: unknown[] }>,
    events: [] as string[],
    sql: [] as Array<{ text: string; values: unknown[]; actor: string }>,
    portCalls: [] as Array<{ name: string; input: any; ctxArg: any; tenantId: string }>,
    logs: [] as string[],
    next: () => id(seq++),
    snapshot: () => structuredClone({ referrers, lines, jobs: w.jobs }),
    restore(s: ReturnType<typeof structuredClone<any>>) { referrers.splice(0, referrers.length, ...s.referrers); lines.splice(0, lines.length, ...s.lines); w.jobs.splice(0, w.jobs.length, ...s.jobs); },
    writes: () => w.sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text)),
    ref: (rid: string) => referrers.find((r) => r.id === rid)!,
    line: (lid: string) => lines.find((l) => l.id === lid)!,
    /** n converted lines of `referrer`, converted_at = `at` (ISO) */
    addConverted(referrer: string, partner: string, n: number, at: string, state = 'converted') {
      for (let i = 0; i < n; i++) {
        const lid = w.next();
        lines.push(line(lid, partner, referrer, state, { line_no: 100 + lines.length, conversion_attempt: 1,
          order_id: state === 'converted' ? w.next() : null, converted_at: state === 'converted' ? at : null }));
      }
    },
    newTx: undefined as unknown as (actor: { type: string; id: string; membershipId?: string }, tenant: string) => any,
  };

  // ---------- RLS / actor scoping ----------
  const callerPartner = (actor: { type: string; membershipId?: string }) => (actor.type === 'partner' ? users.find((u) => u.membership_id === actor.membershipId) : undefined);
  const visible = (table: string, row: Row, tenant: string, actor: { type: string; membershipId?: string }) => {
    if (w.opts.noRls) return true;
    if (row.tenant_id !== tenant) return false;
    if (actor.type !== 'partner') return true;
    const c = callerPartner(actor);
    if (!c || c.status === 'deactivated') return false;
    return table === 'partners' ? row.id === c.partner_id : row.partner_id === c.partner_id;
  };

  // ---------- expressions / predicates ----------
  function evalExpr(raw: string, values: unknown[], current?: Row, col?: string): unknown {
    const e = raw.trim().replace(/::\w+(\[\])?$/i, '');
    if (/^\$\d+$/.test(e)) return values[Number(e.slice(1)) - 1];
    if (/^'.*'$/.test(e)) return e.slice(1, -1).replace(/''/g, "'");
    if (/^NULL$/i.test(e)) return null;
    if (/^(now\(\)|current_timestamp|clock_timestamp\(\)|transaction_timestamp\(\))$/i.test(e)) return w.opts.now ?? NOW;
    if (/^(true|false)$/i.test(e)) return e.toLowerCase() === 'true';
    if (/^-?\d+$/.test(e)) return Number(e);
    const inc = /^(?:\w+\.)?(\w+)\s*\+\s*1$/.exec(e);
    if (inc && current && inc[1] === col) return Number(current[col]) + 1;
    throw new Error(`fake SQL: unsupported expression "${raw}" (use $n params, 'literals', NULL, now(), true/false, col + 1)`);
  }
  type Pred = (r: Row) => boolean;
  function atom(a0: string, values: unknown[]): Pred {
    const a = unparen(a0);
    const ors = splitTop(a, 'OR');
    if (ors.length > 1) { const ps = ors.map((x) => atom(x, values)); return (r) => ps.some((p) => p(r)); }
    let m = /^(?:\w+\.)?(\w+)\s+IS\s+(NOT\s+)?NULL$/i.exec(a);
    if (m) { const [c, not] = [m[1]!, !!m[2]]; return (r) => ((r[c] === null || r[c] === undefined) !== not); }
    m = /^(?:\w+\.)?(\w+)\s*=\s*ANY\s*\(\s*\$(\d+)[^)]*\)$/i.exec(a);
    if (m) { const c = m[1]!; const list = (values[Number(m[2]) - 1] as unknown[]).map((x) => String(x)); return (r) => list.includes(String(r[c])); }
    m = /^(?:\w+\.)?(\w+)\s+(NOT\s+)?IN\s*\(([\s\S]*)\)$/i.exec(a);
    if (m) { const c = m[1]!; const not = !!m[2]; const list = splitTop(m[3]!, ',').map((x) => String(evalExpr(x, values))); return (r) => list.includes(String(r[c])) !== not; }
    m = /^(lower\(\s*)?(?:\w+\.)?(\w+)\s*\)?\s+(I?LIKE)\s+(lower\(\s*)?\$(\d+)(?:::\w+)?\s*\)?(?:\s+ESCAPE\s+'[^']*')?$/i.exec(a);
    if (m) {
      const [lowerCol, c, op, lowerPat] = [!!m[1], m[2]!, m[3]!.toUpperCase(), !!m[4]];
      const pat = String(values[Number(m[5]) - 1]);
      const re = likeRe(lowerPat ? pat.toLowerCase() : pat, op === 'ILIKE');
      return (r) => (r[c] === null || r[c] === undefined ? false : re.test(lowerCol ? String(r[c]).toLowerCase() : String(r[c])));
    }
    m = /^(?:\w+\.)?(\w+)\s*(>=|<=|<>|!=|=|>|<)\s*([\s\S]+)$/.exec(a);
    if (m) {
      const [c, op] = [m[1]!, m[2]!]; const val = evalExpr(m[3]!, values);
      return (r) => {
        if (r[c] === null || r[c] === undefined) return false;
        const x = cmpNorm(r[c], c), y = cmpNorm(val, c);
        return op === '=' ? x === y : op === '<>' || op === '!=' ? x !== y : op === '>' ? x > y : op === '>=' ? x >= y : op === '<' ? x < y : x <= y;
      };
    }
    throw new Error(`fake SQL: unsupported WHERE atom "${a0}"`);
  }
  function where(text: string, values: unknown[]): Pred {
    const clause = /\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|\bFOR\s+UPDATE\b|\bRETURNING\b|$)/i.exec(text)?.[1];
    if (!clause) return () => true;
    const ps = splitTop(clause.trim(), 'AND').map((x) => atom(x, values));
    return (r) => ps.every((p) => p(r));
  }

  // ---------- table constraints ----------
  function checkReferrer(row: Row, others: Row[]) {
    const len = (v: unknown) => (typeof v === 'string' ? [...v].length : 0);
    if (len(row.display_name) < 1 || len(row.display_name) > 120 || len(row.display_name_norm) < 1 || len(row.display_name_norm) > 120) throw pgErr('23514', 'name', 'partner_referrers__name__ck');
    if (row.qualification != null && len(row.qualification) > 120) throw pgErr('23514', 'qual', 'partner_referrers__qual__ck');
    if (row.registration_council != null && len(row.registration_council) > 20) throw pgErr('23514', 'council', 'partner_referrers__council__ck');
    if (row.registration_no != null && len(row.registration_no) > 30) throw pgErr('23514', 'regno', 'partner_referrers__regno__ck');
    if (!['unmapped', 'mapped', 'rejected'].includes(row.mapping_state)) throw pgErr('23514', 'state', 'partner_referrers__state__ck');
    if ((row.mapping_state === 'mapped') !== (row.catalog_doctor_id != null)) throw pgErr('23514', 'mapped', 'partner_referrers__mapped__ck');
    if ((row.mapping_state === 'rejected') !== (row.mapping_reject_reason_code != null)) throw pgErr('23514', 'rejected', 'partner_referrers__rejected__ck');
    if (row.mapping_reject_text != null && len(row.mapping_reject_text) > 300) throw pgErr('23514', 'rej_text', 'partner_referrers__rej_text__ck');
    for (const c of ['id', 'tenant_id', 'partner_id', 'display_name', 'display_name_norm', 'created_by', 'updated_by']) if (row[c] == null) throw pgErr('23502', `null ${c}`);
    if (!partners.some((p) => p.tenant_id === row.tenant_id && p.id === row.partner_id)) throw pgErr('23503', 'partner fk', 'partner_referrers__partner__fk');
    if (row.is_active && others.some((o) => o !== row && o.is_active && o.tenant_id === row.tenant_id && o.partner_id === row.partner_id
      && o.display_name_norm === row.display_name_norm && (o.registration_no ?? '') === (row.registration_no ?? ''))) throw pgErr('23505', 'duplicate referrer', UNIQUE_CONSTRAINT);
  }
  function checkLine(row: Row) {
    if ((row.state === 'conversion_failed') !== (row.failure_code != null)) throw pgErr('23514', 'failure_code iff conversion_failed', 'manifest_lines__failure__ck');
    if (!['draft', 'submitted', 'converting', 'converted', 'conversion_failed', 'not_received', 'withdrawn', 'discarded', 'cancelled'].includes(row.state)) throw pgErr('23514', 'state', 'manifest_lines__state__ck');
    if (row.referrer_id != null && !referrers.some((r) => r.tenant_id === row.tenant_id && r.id === row.referrer_id && r.partner_id === row.partner_id)) throw pgErr('23503', 'referrer fk', 'manifest_lines__referrer__fk');
  }
  const check = (table: string, row: Row, others: Row[]) => { if (table === 'partner_referrers') checkReferrer(row, others); else if (table === 'manifest_lines') checkLine(row); };
  const strip = (r: Row) => { const { __hidden, ...rest } = r; return { ...rest }; };

  w.newTx = (actor: { type: string; id: string; membershipId?: string }, tenant: string) => {
    const tx = {
      startedAt: new Date(), operation: {},
      savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      async query(text: string, values: unknown[] = []) {
        w.sql.push({ text, values, actor: actor.type });
        w.events.push(`SQL ${squash(text)}`);
        if (/pg_advisory_xact_lock/i.test(text)) return { rows: [], rowCount: 0 };
        if (/\bapp\.enqueue_job\s*\(/i.test(text)) {
          const open = text.indexOf('(', text.search(/app\.enqueue_job/i));
          const args = splitTop(text.slice(open + 1, balancedEnd(text, open)), ',').map((x) => evalExpr(x, values));
          if (w.opts.enqueueError) throw w.opts.enqueueError;
          const payload = typeof args[1] === 'string' ? JSON.parse(args[1]) : args[1];
          w.jobs.push({ identifier: String(args[0]), payload, key: String(args[2]), extra: args.slice(3) });
          w.events.push(`JOB ${String(args[2])}`);
          return { rows: [{ enqueue_job: 1 }], rowCount: 1 };
        }
        const t = squash(text);
        const ins = /^INSERT INTO partners\.(\w+)\s*\(([^)]*)\)\s*VALUES\s*(\()/i.exec(t);
        if (ins) {
          const table = ins[1]!; const rows = tables[table];
          if (!rows || table === 'partners') throw new Error(`fake SQL: INSERT into partners.${table} is not part of the T11 flow`);
          const vOpen = t.indexOf('(', ins[0].length - 1); const vEnd = balancedEnd(t, vOpen);
          const cols = ins[2]!.split(',').map((c) => c.trim().toLowerCase()); const vals = splitTop(t.slice(vOpen + 1, vEnd), ',');
          if (cols.length !== vals.length) throw new Error('fake SQL: INSERT column/value count mismatch');
          const rest = t.slice(vEnd + 1);
          const row: Row = table === 'partner_referrers'
            ? { id: w.next(), version: 1, is_active: true, mapping_state: 'unmapped', catalog_doctor_id: null, mapped_at: null, mapped_by: null, mapping_reject_reason_code: null,
              mapping_reject_text: null, qualification: null, registration_council: null, registration_no: null, created_at: NOW, updated_at: NOW }
            : { id: w.next() };
          cols.forEach((c, i) => { row[c] = evalExpr(vals[i]!, values); });
          if (!w.opts.noRls && row.tenant_id !== tenant) throw pgErr('42501', 'rls tenant');
          if (!w.opts.noRls && actor.type === 'partner' && row.partner_id !== callerPartner(actor)?.partner_id) throw pgErr('42501', 'rls partner');
          const doNothing = /ON CONFLICT[\s\S]*DO NOTHING/i.test(rest);
          try { check(table, row, rows); } catch (e: any) {
            if (doNothing && e.code === '23505') return { rows: [], rowCount: 0 };
            throw e;
          }
          rows.push(row);
          return { rows: /\bRETURNING\b/i.test(rest) ? [strip(row)] : [], rowCount: 1 };
        }
        const upd = /^UPDATE partners\.(\w+)\s+(?:(?:AS\s+)?(?!SET\b)\w+\s+)?SET\s+([\s\S]*?)\s+WHERE\b/i.exec(t);
        if (upd) {
          const table = upd[1]!; const rows = tables[table];
          if (!rows || table === 'partners') throw new Error(`fake SQL: UPDATE of partners.${table} is not part of the T11 flow`);
          const pred = where(t, values);
          const targets = rows.filter((r) => !r.__hidden && pred(r) && visible(table, r, tenant, actor));
          const sets = splitTop(upd[2]!, ',');
          for (const row of targets) {
            const nu = { ...row };
            for (const s of sets) {
              const sm = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(s);
              if (!sm) throw new Error(`fake SQL: unsupported SET item "${s}"`);
              nu[sm[1]!.toLowerCase()] = evalExpr(sm[2]!, values, row, sm[1]!.toLowerCase());
            }
            check(table, nu, rows.filter((x) => x !== row));
            Object.assign(row, nu);
          }
          return { rows: /\bRETURNING\b/i.test(t) ? targets.map(strip) : [], rowCount: targets.length };
        }
        if (/^SELECT\b/i.test(t) && /\bFROM\s+partners\.g_cs_reasons\b/i.test(t)) { // 05-SCHEMA §7: no tenant column; set_name / code may be literal or bound
          const rows = w.reasons.filter((r) => (t.includes(`'${r['set_name']}'`) || values.includes(r['set_name'])) && (!/\bcode\s*=\s*\$\d+/i.test(t) || values.includes(r['code'])));
          return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
        }
        const sel = /^SELECT\b[\s\S]*?\bFROM\s+partners\.(\w+)/i.exec(t);
        if (sel) {
          const table = sel[1]!; const rows = tables[table];
          if (!rows) throw new Error(`fake SQL: SELECT from partners.${table} is not part of the T11 flow`);
          if (/\bJOIN\b/i.test(t)) throw new Error('fake SQL: JOIN unsupported (single-table selects only)');
          if (/\(\s*SELECT\b/i.test(t.slice(6))) throw new Error('fake SQL: sub-selects unsupported');
          const pred = where(t, values);
          let found = rows.filter((r) => !r.__hidden && pred(r) && visible(table, r, tenant, actor));
          const cnt = /\bcount\s*\(([^)]*)\)\s*(::\s*(?:int|integer|bigint))?\s*(?:AS\s+)?(\w+)?/i.exec(t);
          if (cnt) {
            const alias = cnt[3] && !/^(FROM|WHERE|GROUP|ORDER|LIMIT)$/i.test(cnt[3]) ? cnt[3] : 'count';
            const num = !!cnt[2] && /int/i.test(cnt[2]);
            const gb = /\bGROUP\s+BY\s+(?:\w+\.)?(\w+)/i.exec(t)?.[1];
            if (gb) {
              const g = new Map<string, number>();
              for (const r of found) g.set(String(r[gb]), (g.get(String(r[gb])) ?? 0) + 1);
              const out = [...g].map(([k, n]) => ({ [gb]: k === 'null' ? null : k, [alias]: num ? n : String(n) }));
              return { rows: out, rowCount: out.length };
            }
            return { rows: [{ [alias]: num ? found.length : String(found.length) }], rowCount: 1 };
          }
          const off = /\bOFFSET\s+(?:\$(\d+)|(\d+))/i.exec(t); const lim = /\bLIMIT\s+(?:\$(\d+)|(\d+))/i.exec(t);
          const offN = off ? Number(off[2] ?? values[Number(off[1]) - 1]) : 0;
          if (lim) found = found.slice(offN, offN + Number(lim[2] ?? values[Number(lim[1]) - 1]));
          else if (offN) found = found.slice(offN);
          return { rows: found.map(strip), rowCount: found.length };
        }
        throw new Error(`fake SQL: unexpected statement in referrer flow: ${text}`);
      },
    };
    return tx;
  };
  return w;
}
export type World = ReturnType<typeof makeWorld>;

/** Builds ctx + port fakes for `who`; installs the partnerContext.require fake through `setRequire`. */
export function makeCtx(w: World, who: Who, setRequire: (fn: (ctx: any) => Promise<unknown>) => void, over: Opts = {}) {
  w.opts = over;
  if (over.hiddenDuplicate) w.referrers.push({ __hidden: true, ...over.hiddenDuplicate });
  const isStaff = who === 'staff' || who === 'staffNoMap' || who === 'staffB';
  const pu = isStaff ? undefined : w.users.find((u) => u.id === U[who])!;
  const tenant = who === 'staffB' ? T_B : pu ? pu.tenant_id : T_A;
  const st = who === 'staffB' ? STAFF_B : who === 'staffNoMap' ? STAFF_NO_MAP : STAFF;
  const actor: any = isStaff ? { type: 'user', id: st.id, membershipId: st.membershipId } : { type: 'partner', id: pu!.id, membershipId: pu!.membership_id };
  const perms = isStaff ? (who === 'staffNoMap' ? ['partners.partner.read'] : ['partners.referrer.map']) : pu!.partner_role === 'partner_admin' ? ADMIN_PERMS : MEMBER_PERMS;
  const tx = w.newTx(actor, tenant);
  const nowIso = over.now ?? NOW;
  const record = (name: string, input: any, ctxArg: any) => { w.events.push(`PORT ${name}`); w.portCalls.push({ name, input, ctxArg, tenantId: ctxArg?.tenantId }); };
  const ctx: any = {
    tenantId: tenant, actor, requestId: id(99), tx, now: () => nowIso, db: { tx: async (fn: any) => fn(ctx) }, core: {},
    audit: { access: async () => undefined }, events: {}, uploads: {}, files: {}, storage: {}, services: {}, operationId: 'x', clientIp: '127.0.0.1', download: {},
    noRetry: () => undefined,
    log: { info: (o: object) => w.logs.push(JSON.stringify(o)), warn: (o: object) => w.logs.push(JSON.stringify(o)), error: (o: object) => w.logs.push(JSON.stringify(o)) },
    ports: {
      IdentityPort: {
        async assertRole(c: any, req: { permission: string }) {
          record('assertRole', req, c); w.events.push(`ASSERT ${req.permission}`);
          if (!perms.includes(req.permission)) throw new LimsError('auth.forbidden');
        },
        async getTenantSettings(c: any, input: { keys?: string[] } = {}) {
          record('getTenantSettings', input, c);
          return { timezone: over.timezone ?? 'Asia/Kathmandu', calendarDisplay: 'BS' };
        },
      },
      CatalogPort: {
        async getReferrer(c: any, input: { referrerId: string; purpose: string }) {
          record('getReferrer', input, c);
          if (over.catalogError) throw over.catalogError;
          const d = w.doctors.find((x) => x.referrerId === input.referrerId && x.tenant === c.tenantId);
          if (!d) throw new LimsError('common.not_found');
          const { tenant: _t, ...profile } = d;
          return profile;
        },
      },
    },
  };
  setRequire(async (c: any) => {
    if (c.actor?.type !== 'partner') throw new LimsError('auth.forbidden');
    const row = w.users.find((u) => u.tenant_id === c.tenantId && u.membership_id === c.actor.membershipId);
    const p = row && w.partners.find((x) => x.tenant_id === row.tenant_id && x.id === row.partner_id);
    if (!row || row.status === 'deactivated' || p?.status !== 'active') throw new LimsError('partners.partner_inactive');
    const r = Object.freeze({ partnerId: row.partner_id, partnerUserId: row.id, role: row.partner_role });
    c.partner = r;
    return r;
  });
  return { ctx, actor, tenant };
}
