// C13 T15 test fixture (not a test file): in-memory emulation of partners.pickup_requests / pickup_request_manifests / manifests / partners / settings / g_cs_reasons
// over the `tx.query(text, values)` seam, plus IdentityPort / partnerContext fakes. Synthetic data only. Self-contained (same SQL subset as referrer.world.ts).
// The fake parses the writer's SQL (SINGLE-TABLE statements, no JOIN, no sub-select) so the tests exercise the real WHERE clauses:
//   SELECT  : FROM partners.<table> [alias] WHERE <AND-conjunction; OR groups allowed> [ORDER BY col [DESC][, …]] [LIMIT $n|n] [OFFSET $n|n] [FOR UPDATE]
//             atoms: col = $n | 'lit' | true | n ; <> != > >= < <= ; col = ANY($n[::uuid[]]) ; col [NOT] IN (…) ; col IS [NOT] NULL.
//   INSERT  : INSERT INTO partners.<table> (cols) VALUES (…) [RETURNING …] — values $n | 'lit' | NULL | now() | true/false | n.
//   UPDATE  : UPDATE partners.<table> [alias] SET col = $n | 'lit' | NULL | now() | true/false | n | col + 1, … WHERE … [RETURNING …].
// Concurrency model (so a real concurrent-create test is possible): every call gets its own transaction. Rows inserted by an open tx are invisible to the others
//   until commit; SELECT … FOR UPDATE and UPDATE take a row lock (held to commit/rollback; waiters re-check the predicate afterwards, READ COMMITTED);
//   a unique-index conflict with another tx's uncommitted row waits for that tx first. A lock wait that never ends raises 40P01 (deadlock).
// Constraints of 05-SCHEMA §3.6 are enforced (pickup_requests CHECKs; link partial unique index on (tenant_id, manifest_id) WHERE is_open; link FKs).
// RLS emulation (unless opts.noRls): tenant, partner actors see own partner rows only, staff actors see only their receiving centres (all-centres staff see all).
// Partner-column guard (05-SCHEMA §8 guard_partner_columns, AB11): a partner actor UPDATE touching scheduled_* / assignee_text / picked_up_at / in_transit_at throws immutable_row.
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export const id = (n: number) => `01940e00-0000-7000-8000-c1315${String(n).padStart(7, '0')}`;
export const T_A = id(1), T_B = id(2);
export const P = { X: id(10), Y: id(11), Z: id(12), B: id(13) };
export const NOW = '2026-11-13T04:00:00.000Z';
export const NOW_MS = Date.parse(NOW);
export const HOUR = 3_600_000, DAY = 24 * HOUR;
export const iso = (ms: number) => new Date(ms).toISOString();

export type Who = 'adminX' | 'memberX' | 'adminY' | 'memberY' | 'adminZ' | 'adminB' | 'staff' | 'staffC1' | 'staffC2' | 'staffNoManage' | 'staffB';
export const U: Record<string, string> = { adminX: id(20), memberX: id(21), adminY: id(22), memberY: id(23), adminZ: id(24), adminB: id(25) };
export const M: Record<string, string> = { adminX: id(30), memberX: id(31), adminY: id(32), memberY: id(33), adminZ: id(34), adminB: id(35) };
export const STAFFS: Record<string, { id: string; membershipId: string; centres: string[] | 'all'; perms: string[]; tenant: string }> = {
  staff: { id: id(50), membershipId: id(51), centres: 'all', perms: ['partners.pickup.manage'], tenant: T_A },
  staffC1: { id: id(52), membershipId: id(53), centres: [id(200)], perms: ['partners.pickup.manage'], tenant: T_A },
  staffC2: { id: id(54), membershipId: id(55), centres: [id(201)], perms: ['partners.pickup.manage'], tenant: T_A },
  staffNoManage: { id: id(56), membershipId: id(57), centres: 'all', perms: ['partners.partner.read', 'partners.manifest.receive'], tenant: T_A },
  staffB: { id: id(58), membershipId: id(59), centres: 'all', perms: ['partners.pickup.manage'], tenant: T_B },
};
export const C = { c1: id(200), c2: id(201), b: id(202) };
/** manifests */
export const MF = { m1: id(210), m2: id(211), m3: id(212), draft: id(213), received: id(214), withdrawn: id(215), c2: id(216), open: id(217), y: id(218), b: id(219), m4: id(220),
  m5: id(221), sch: id(222), picked: id(223), y2: id(224), c2b: id(225), canc: id(226), rej: id(227), two: id(228), detached: id(229) };
/** pickups */
export const PK = { req: id(230), sch: id(231), picked: id(232), canc: id(233), rej: id(234), y: id(235), b: id(236), c2: id(237), two: id(238) };
export const REASON_CANCEL = ['no_longer_needed', 'will_deliver_ourselves', 'manifest_withdrawn', 'other'];
export const REASON_REJECT = ['outside_service_area', 'no_rider_available', 'window_too_short', 'other'];
export const UNIQUE_LINK = 'pickup_request_manifests__tenant_id_manifest_id__open_uq';

const PARTNER_PERMS = ['partners.pickup.request', 'partners.order.read', 'partners.referrer.read'];
export const pgErr = (code: string, message: string, constraint?: string) => Object.assign(new Error(message), { code, constraint });

export interface Opts {
  /** ctx.now() (ISO string) */
  now?: string;
  /** emulate a handler that forgets its own scoping: no RLS help */
  noRls?: boolean;
  /** drop the unique index on open links (proves the FOR UPDATE + re-check path alone) */
  noUniqueIndex?: boolean;
  /** this permission is denied by IdentityPort.assertRole */
  deny?: string;
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
const tsCol = (c: string) => /_(at|start|end|from|to)$/.test(c);
function cmpNorm(v: unknown, col: string): string | number {
  if (v instanceof Date) return v.getTime();
  if (tsCol(col) && typeof v === 'string') return Date.parse(v);
  return String(v);
}
const sleep = () => new Promise<void>((r) => setTimeout(r, 0));

export function makeWorld() {
  const partners: Row[] = [
    { id: P.X, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active', contact_phone_e164: '+15555550101', address_text: 'Synthetic address X, Ward 1' },
    { id: P.Y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active', contact_phone_e164: null, address_text: null },
    { id: P.Z, tenant_id: T_A, partner_code: 'SYN-Z', name: 'Synthetic Partner Z', status: 'suspended', contact_phone_e164: null, address_text: null },
    { id: P.B, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active', contact_phone_e164: null, address_text: null },
  ];
  const mkUser = (k: string, tenant: string, partner: string, role: string, status = 'active') => ({ id: U[k], tenant_id: tenant, partner_id: partner, membership_id: M[k], partner_role: role, status });
  const users: Row[] = [
    mkUser('adminX', T_A, P.X, 'partner_admin'), mkUser('memberX', T_A, P.X, 'partner_member'), mkUser('adminY', T_A, P.Y, 'partner_admin'),
    mkUser('memberY', T_A, P.Y, 'partner_member'), mkUser('adminZ', T_A, P.Z, 'partner_admin'), mkUser('adminB', T_B, P.B, 'partner_admin'),
  ];
  let mseq = 0;
  const manifest = (mid: string, partner: string, state: string, centre = C.c1, over: Row = {}): Row => ({
    id: mid, tenant_id: partner === P.B ? T_B : T_A, partner_id: partner, manifest_no: `MF26${String(++mseq).padStart(6, '0')}`, state, receiving_centre_id: centre,
    in_transit_at: null, received_at: null, version: 2, updated_at: NOW, updated_by: U.adminX, ...over,
  });
  const manifests: Row[] = [
    manifest(MF.m1, P.X, 'submitted'), manifest(MF.m2, P.X, 'submitted'), manifest(MF.m3, P.X, 'partially_received'), manifest(MF.draft, P.X, 'draft'),
    manifest(MF.received, P.X, 'received', C.c1, { received_at: NOW }), manifest(MF.withdrawn, P.X, 'withdrawn'), manifest(MF.c2, P.X, 'submitted', C.c2),
    manifest(MF.open, P.X, 'submitted'), manifest(MF.y, P.Y, 'submitted'), manifest(MF.b, P.B, 'submitted', C.b), manifest(MF.m4, P.X, 'submitted'), manifest(MF.m5, P.X, 'submitted'),
    manifest(MF.sch, P.X, 'submitted'), manifest(MF.picked, P.X, 'submitted', C.c1, { in_transit_at: '2026-11-12T04:00:00.000Z' }), manifest(MF.y2, P.Y, 'submitted'),
    manifest(MF.c2b, P.X, 'submitted', C.c2), manifest(MF.canc, P.X, 'submitted'), manifest(MF.rej, P.X, 'submitted'), manifest(MF.two, P.X, 'submitted'), manifest(MF.detached, P.X, 'submitted'),
  ];
  let cseq = 0;
  const pickup = (pid: string, partner: string, state: string, centre: string, over: Row = {}): Row => ({
    id: pid, tenant_id: partner === P.B ? T_B : T_A, partner_id: partner, receiving_centre_id: centre, state,
    window_start: iso(NOW_MS + DAY), window_end: iso(NOW_MS + DAY + 4 * HOUR), packages_count: 2, notes: null, contact_name: null, contact_phone_e164: null,
    scheduled_start: null, scheduled_end: null, assignee_text: null, picked_up_at: null, cancel_reason_code: null, reject_reason_code: null, resolved_at: null, resolved_by: null,
    version: 1, is_active: true, created_at: iso(NOW_MS - 10 * HOUR + (++cseq) * 60_000), created_by: partner === P.Y ? U.adminY : U.adminX, updated_at: NOW, updated_by: U.adminX, ...over,
  });
  const pickups: Row[] = [
    pickup(PK.req, P.X, 'requested', C.c1, { notes: 'Synthetic gate note', contact_name: 'Synthetic Contact', contact_phone_e164: '+15555550123', window_start: iso(NOW_MS + 2 * DAY) , window_end: iso(NOW_MS + 2 * DAY + 3 * HOUR) }),
    pickup(PK.sch, P.X, 'scheduled', C.c1, { version: 2, scheduled_start: iso(NOW_MS + DAY + HOUR), scheduled_end: iso(NOW_MS + DAY + 2 * HOUR), assignee_text: 'Synthetic Rider', window_start: iso(NOW_MS + DAY) }),
    pickup(PK.picked, P.X, 'picked_up', C.c1, { version: 3, picked_up_at: '2026-11-12T04:00:00.000Z', resolved_at: '2026-11-12T04:00:00.000Z', resolved_by: STAFFS['staff']!.id,
      scheduled_start: '2026-11-12T03:00:00.000Z', scheduled_end: '2026-11-12T05:00:00.000Z', assignee_text: 'Synthetic Rider', window_start: iso(NOW_MS - 2 * DAY), window_end: iso(NOW_MS - 2 * DAY + HOUR) }),
    pickup(PK.canc, P.X, 'cancelled', C.c1, { version: 2, cancel_reason_code: 'no_longer_needed', resolved_at: NOW, resolved_by: U.adminX, window_start: iso(NOW_MS + 3 * DAY), window_end: iso(NOW_MS + 3 * DAY + HOUR) }),
    pickup(PK.rej, P.X, 'rejected', C.c1, { version: 2, reject_reason_code: 'no_rider_available', resolved_at: NOW, resolved_by: STAFFS['staff']!.id, window_start: iso(NOW_MS + 4 * DAY), window_end: iso(NOW_MS + 4 * DAY + HOUR) }),
    pickup(PK.y, P.Y, 'requested', C.c1, { window_start: iso(NOW_MS + 5 * DAY), window_end: iso(NOW_MS + 5 * DAY + HOUR) }),
    pickup(PK.b, P.B, 'requested', C.b),
    pickup(PK.c2, P.X, 'requested', C.c2, { window_start: iso(NOW_MS + 6 * DAY), window_end: iso(NOW_MS + 6 * DAY + HOUR) }),
    pickup(PK.two, P.X, 'requested', C.c1, { window_start: iso(NOW_MS + 12 * HOUR), window_end: iso(NOW_MS + 16 * HOUR), packages_count: 3 }),
  ];
  const link = (pid: string, mid: string, partner: string, centre: string, isOpen: boolean): Row => ({
    tenant_id: partner === P.B ? T_B : T_A, pickup_request_id: pid, manifest_id: mid, partner_id: partner, receiving_centre_id: centre, is_open: isOpen, created_at: NOW, created_by: U.adminX, updated_at: NOW, updated_by: U.adminX,
  });
  const links: Row[] = [
    link(PK.req, MF.open, P.X, C.c1, true), link(PK.sch, MF.sch, P.X, C.c1, true), link(PK.picked, MF.picked, P.X, C.c1, false), link(PK.canc, MF.canc, P.X, C.c1, false),
    link(PK.rej, MF.rej, P.X, C.c1, false), link(PK.y, MF.y2, P.Y, C.c1, true), link(PK.b, MF.b, P.B, C.b, true), link(PK.c2, MF.c2b, P.X, C.c2, true),
    link(PK.two, MF.two, P.X, C.c1, true), link(PK.two, MF.detached, P.X, C.c1, false), // detached = MS5 (is_open = false on a still-open pickup)
  ];
  const reasons: Row[] = [
    ...REASON_CANCEL.map((code, i) => ({ set_name: 'pickup_cancel_reasons', code, requires_text: false, is_active: true, sort_order: i + 1 })),
    ...REASON_REJECT.map((code, i) => ({ set_name: 'pickup_reject_reasons', code, requires_text: false, is_active: true, sort_order: i + 1 })),
  ];
  const settings: Row[] = []; // no row = defaults (pickup_max_days_ahead 7)
  let seq = 500, txSeq = 0;
  const tables: Record<string, Row[]> = { partners, manifests, pickup_requests: pickups, pickup_request_manifests: links, settings };
  const w = {
    partners, users, manifests, pickups, links, settings, reasons,
    opts: {} as Opts,
    sql: [] as Array<{ text: string; values: unknown[]; actor: string; tx: number }>,
    portCalls: [] as Array<{ name: string; input: any; ctxArg: any }>,
    logs: [] as string[],
    next: () => id(seq++),
    writes: () => w.sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text)),
    pk: (pid: string) => pickups.find((r) => r.id === pid)!,
    mf: (mid: string) => manifests.find((r) => r.id === mid)!,
    openLinks: (mid: string) => links.filter((l) => l.manifest_id === mid && l.is_open && !l.__tx),
    linksOf: (pid: string) => links.filter((l) => l.pickup_request_id === pid),
    /** n extra submitted manifests of `partner` at centre c1 (ids returned) */
    addManifests(n: number, partner = P.X, centre = C.c1, state = 'submitted') {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) { const mid = w.next(); manifests.push(manifest(mid, partner, state, centre)); ids.push(mid); }
      return ids;
    },
    snapshot: () => JSON.stringify([pickups, links, manifests, settings]),
    begin: undefined as unknown as (actor: { type: string; id: string; membershipId?: string }, tenant: string) => Tx,
  };
  interface Tx { id: number; query: (text: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }>; commit: () => void; rollback: () => void; [k: string]: unknown }

  // ---------- RLS / actor scoping ----------
  const callerPartner = (actor: { type: string; membershipId?: string }) => (actor.type === 'partner' ? users.find((u) => u.membership_id === actor.membershipId) : undefined);
  const staffOf = (actor: { type: string; membershipId?: string }) => Object.values(STAFFS).find((s) => s.membershipId === actor.membershipId);
  const visible = (table: string, row: Row, tenant: string, actor: { type: string; membershipId?: string }, txId: number) => {
    if (row.__tx && row.__tx !== txId) return false; // uncommitted insert of another tx
    if (w.opts.noRls) return true;
    if (row.tenant_id !== tenant) return false;
    if (table === 'settings') return true;
    if (actor.type === 'partner') {
      const c = callerPartner(actor);
      if (!c || c.status === 'deactivated') return false;
      return table === 'partners' ? row.id === c.partner_id : row.partner_id === c.partner_id;
    }
    if (table === 'partners') return true;
    const s = staffOf(actor);
    if (s && s.centres !== 'all' && 'receiving_centre_id' in row) return s.centres.includes(row.receiving_centre_id);
    return true;
  };

  // ---------- expressions / predicates ----------
  function evalExpr(raw: string, values: unknown[], current?: Row, col?: string): unknown {
    const e = raw.trim().replace(/::\w+(\[\])?$/i, '');
    if (/^\$\d+$/.test(e)) return values[Number(e.slice(1)) - 1];
    if (/^'.*'$/.test(e)) return e.slice(1, -1).replace(/''/g, "'");
    if (/^NULL$/i.test(e)) return null;
    if (/^(now\(\)|current_timestamp|clock_timestamp\(\)|transaction_timestamp\(\))$/i.test(e)) return w.opts.now ?? NOW;
    if (/^(gen_random_uuid|uuidv7|uuid_generate_v7)\(\)$/i.test(e)) return w.next();
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
  function orderBy(rows: Row[], t: string): Row[] {
    const clause = /\bORDER\s+BY\b([\s\S]*?)(?=\bLIMIT\b|\bOFFSET\b|\bFOR\s+UPDATE\b|\bRETURNING\b|$)/i.exec(t)?.[1];
    if (!clause) return rows;
    const keys = splitTop(clause.trim(), ',').map((k) => { const mm = /^(?:\w+\.)?(\w+)(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i.exec(k.trim()); if (!mm) throw new Error(`fake SQL: unsupported ORDER BY item "${k}"`); return { c: mm[1]!, desc: /desc/i.test(mm[2] ?? '') }; });
    return [...rows].sort((a, b) => {
      for (const { c, desc } of keys) {
        const x = cmpNorm(a[c], c), y = cmpNorm(b[c], c);
        if (x < y) return desc ? 1 : -1;
        if (x > y) return desc ? -1 : 1;
      }
      return 0;
    });
  }

  // ---------- table constraints ----------
  function checkPickup(r: Row) {
    const len = (v: unknown) => (typeof v === 'string' ? [...v].length : 0);
    if (!['requested', 'scheduled', 'picked_up', 'cancelled', 'rejected'].includes(r.state)) throw pgErr('23514', 'state', 'pickup_requests__state__ck');
    if (!(Date.parse(r.window_start) < Date.parse(r.window_end))) throw pgErr('23514', 'window', 'pickup_requests__window__ck');
    if (!(Number.isInteger(r.packages_count) && r.packages_count >= 1 && r.packages_count <= 50)) throw pgErr('23514', 'packages', 'pickup_requests__packages__ck');
    if (r.notes != null && len(r.notes) > 500) throw pgErr('23514', 'notes', 'pickup_requests__notes__ck');
    if (r.contact_name != null && len(r.contact_name) > 80) throw pgErr('23514', 'contact', 'pickup_requests__contact__ck');
    if (r.contact_phone_e164 != null && !/^\+[1-9][0-9]{7,14}$/.test(r.contact_phone_e164)) throw pgErr('23514', 'phone', 'pickup_requests__phone__ck');
    if ((r.scheduled_start == null) !== (r.scheduled_end == null) || (r.scheduled_start != null && !(Date.parse(r.scheduled_start) < Date.parse(r.scheduled_end)))) throw pgErr('23514', 'sched', 'pickup_requests__sched__ck');
    if (r.state === 'scheduled' && r.scheduled_start == null) throw pgErr('23514', 'sched_state', 'pickup_requests__sched_state__ck');
    if (r.assignee_text != null && len(r.assignee_text) > 80) throw pgErr('23514', 'assignee', 'pickup_requests__assignee__ck');
    if ((r.state === 'picked_up') !== (r.picked_up_at != null)) throw pgErr('23514', 'picked', 'pickup_requests__picked__ck');
    if ((r.state === 'cancelled') !== (r.cancel_reason_code != null)) throw pgErr('23514', 'cancel', 'pickup_requests__cancel__ck');
    if ((r.state === 'rejected') !== (r.reject_reason_code != null)) throw pgErr('23514', 'reject', 'pickup_requests__reject__ck');
    for (const c of ['id', 'tenant_id', 'partner_id', 'receiving_centre_id', 'created_by', 'updated_by']) if (r[c] == null) throw pgErr('23502', `null ${c}`);
    if (!partners.some((p) => p.tenant_id === r.tenant_id && p.id === r.partner_id)) throw pgErr('23503', 'partner fk', 'pickup_requests__partner__fk');
  }
  function checkLinkFk(r: Row) {
    if (!manifests.some((m) => m.tenant_id === r.tenant_id && m.id === r.manifest_id && m.partner_id === r.partner_id)) throw pgErr('23503', 'manifest fk (tenant, manifest, partner)', 'pickup_request_manifests__manifest__fk');
    if (!pickups.some((p) => p.tenant_id === r.tenant_id && p.id === r.pickup_request_id && p.partner_id === r.partner_id)) throw pgErr('23503', 'pickup fk (tenant, pickup, partner)', 'pickup_request_manifests__pickup__fk');
  }
  const strip = (r: Row) => { const { __tx, __lock, ...rest } = r; return { ...rest }; };
  const PARTNER_FORBIDDEN: Record<string, string[]> = { pickup_requests: ['scheduled_start', 'scheduled_end', 'assignee_text', 'picked_up_at'], manifests: ['in_transit_at', 'received_at', 'received_by', 'state'] };

  w.begin = (actor, tenant) => {
    const txId = ++txSeq;
    const undo: Array<() => void> = []; const held = new Set<Row>();
    async function lock(row: Row) {
      let spins = 0;
      while (row.__lock && row.__lock !== txId) { if (++spins > 3000) throw pgErr('40P01', 'deadlock detected'); await sleep(); }
      row.__lock = txId; held.add(row);
    }
    const release = () => { for (const r of held) if (r.__lock === txId) delete r.__lock; held.clear(); };
    const tx: Tx = {
      id: txId, startedAt: new Date(), operation: {},
      savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      commit() { for (const r of [...links, ...pickups]) if (r.__tx === txId) delete r.__tx; release(); },
      rollback() { for (const u of undo.reverse()) u(); undo.length = 0; release(); },
      async query(text: string, values: unknown[] = []) {
        w.sql.push({ text, values, actor: actor.type, tx: txId });
        await sleep(); // let concurrent transactions interleave
        if (/pg_advisory_xact_lock/i.test(text)) return { rows: [], rowCount: 0 };
        const t = squash(text);
        const ins = /^INSERT INTO partners\.(\w+)\s*\(([^)]*)\)\s*VALUES\s*(\()/i.exec(t);
        if (ins) {
          const table = ins[1]!; const rows = tables[table];
          if (!rows || !['pickup_requests', 'pickup_request_manifests'].includes(table)) throw new Error(`fake SQL: INSERT into partners.${table} is not part of the T15 flow`);
          const vOpen = t.indexOf('(', ins[0].length - 1); const vEnd = balancedEnd(t, vOpen);
          const cols = ins[2]!.split(',').map((c) => c.trim().toLowerCase()); const vals = splitTop(t.slice(vOpen + 1, vEnd), ',');
          if (cols.length !== vals.length) throw new Error('fake SQL: INSERT column/value count mismatch');
          const row: Row = table === 'pickup_requests'
            ? { id: w.next(), state: 'requested', version: 1, is_active: true, notes: null, contact_name: null, contact_phone_e164: null, scheduled_start: null, scheduled_end: null, assignee_text: null,
              picked_up_at: null, cancel_reason_code: null, reject_reason_code: null, resolved_at: null, resolved_by: null, created_at: w.opts.now ?? NOW, updated_at: w.opts.now ?? NOW }
            : { is_open: true, created_at: w.opts.now ?? NOW, updated_at: w.opts.now ?? NOW };
          cols.forEach((c, i) => { row[c] = evalExpr(vals[i]!, values); });
          if (table === 'pickup_request_manifests' && row.updated_by == null) row.updated_by = row.created_by;
          if (!w.opts.noRls && row.tenant_id !== tenant) throw pgErr('42501', 'rls tenant');
          if (!w.opts.noRls && actor.type === 'partner' && row.partner_id !== callerPartner(actor)?.partner_id) throw pgErr('42501', 'rls partner');
          if (!w.opts.noRls && actor.type !== 'partner') { const s = staffOf(actor); if (s && s.centres !== 'all' && !s.centres.includes(row.receiving_centre_id)) throw pgErr('42501', 'rls centre'); }
          if (table === 'pickup_requests') checkPickup(row);
          else {
            // the pickup row of this link may be an uncommitted insert of this very tx; the FK also needs the manifest
            checkLinkFk(row);
            for (let spin = 0; !w.opts.noUniqueIndex && row.is_open; spin++) {
              const clash = links.find((o) => o.is_open && o.tenant_id === row.tenant_id && o.manifest_id === row.manifest_id);
              if (!clash) break;
              if (clash.__tx && clash.__tx !== txId && spin < 3000) { await sleep(); continue; } // blocked on the other tx
              throw pgErr('23505', 'one open pickup per manifest', UNIQUE_LINK);
            }
          }
          row.__tx = txId; rows.push(row); undo.push(() => { const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1); });
          return { rows: /\bRETURNING\b/i.test(t) ? [strip(row)] : [], rowCount: 1 };
        }
        const upd = /^UPDATE partners\.(\w+)\s+(?:(?:AS\s+)?(?!SET\b)\w+\s+)?SET\s+([\s\S]*?)\s+WHERE\b/i.exec(t);
        if (upd) {
          const table = upd[1]!; const rows = tables[table];
          if (!rows || !['pickup_requests', 'pickup_request_manifests', 'manifests'].includes(table)) throw new Error(`fake SQL: UPDATE of partners.${table} is not part of the T15 flow`);
          const sets = splitTop(upd[2]!, ',').map((s) => { const sm = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(s); if (!sm) throw new Error(`fake SQL: unsupported SET item "${s}"`); return { c: sm[1]!.toLowerCase(), e: sm[2]! }; });
          if (actor.type === 'partner' && !w.opts.noRls) for (const s of sets) if ((PARTNER_FORBIDDEN[table] ?? []).includes(s.c)) throw pgErr('P0001', `immutable_row: ${table}.${s.c} (guard_partner_columns)`);
          if (actor.type === 'partner' && table === 'pickup_request_manifests') for (const s of sets) if (!['is_open', 'updated_at', 'updated_by'].includes(s.c)) throw pgErr('P0001', `immutable_row: ${table}.${s.c}`);
          const pred = where(t, values);
          const targets: Row[] = [];
          for (const row of rows.filter((r) => pred(r) && visible(table, r, tenant, actor, txId))) {
            await lock(row);
            if (pred(row)) targets.push(row); // re-check after the lock (READ COMMITTED)
          }
          for (const row of targets) {
            const before = { ...row }; const nu = { ...row };
            for (const s of sets) nu[s.c] = evalExpr(s.e, values, row, s.c);
            if (table === 'pickup_requests') checkPickup(nu);
            Object.assign(row, nu); undo.push(() => { Object.assign(row, before); });
          }
          return { rows: /\bRETURNING\b/i.test(t) ? targets.map(strip) : [], rowCount: targets.length };
        }
        if (/^SELECT\b/i.test(t) && /\bFROM\s+partners\.g_cs_reasons\b/i.test(t)) { // 05-SCHEMA §7: no tenant column; set_name / code literal or bound
          const rs = w.reasons.filter((r) => (t.includes(`'${r['set_name']}'`) || values.includes(r['set_name'])) && (!/\bcode\s*=\s*\$\d+/i.test(t) || values.includes(r['code'])));
          return { rows: rs.map((r) => ({ ...r })), rowCount: rs.length };
        }
        const sel = /^SELECT\b[\s\S]*?\bFROM\s+partners\.(\w+)/i.exec(t);
        if (sel) {
          const table = sel[1]!; const rows = tables[table];
          if (!rows) throw new Error(`fake SQL: SELECT from partners.${table} is not part of the T15 flow`);
          if (/\bJOIN\b/i.test(t)) throw new Error('fake SQL: JOIN unsupported (single-table selects only)');
          if (/\(\s*SELECT\b/i.test(t.slice(6))) throw new Error('fake SQL: sub-selects unsupported');
          if (/\bGROUP\s+BY\b|\bcount\s*\(/i.test(t)) throw new Error('fake SQL: aggregates are not part of the T15 flow');
          const pred = where(t, values);
          let found = orderBy(rows.filter((r) => pred(r) && visible(table, r, tenant, actor, txId)), t);
          const off = /\bOFFSET\s+(?:\$(\d+)|(\d+))/i.exec(t); const lim = /\bLIMIT\s+(?:\$(\d+)|(\d+))/i.exec(t);
          const offN = off ? Number(off[2] ?? values[Number(off[1]) - 1]) : 0;
          if (lim) found = found.slice(offN, offN + Number(lim[2] ?? values[Number(lim[1]) - 1]));
          else if (offN) found = found.slice(offN);
          if (/\bFOR\s+UPDATE\b/i.test(t)) {
            const locked: Row[] = [];
            for (const row of found) { await lock(row); if (pred(row)) locked.push(row); }
            found = locked;
          }
          return { rows: found.map(strip), rowCount: found.length };
        }
        throw new Error(`fake SQL: unexpected statement in pickup flow: ${text}`);
      },
    };
    return tx;
  };
  return w;
}
export type World = ReturnType<typeof makeWorld>;

/** Builds ctx + port fakes for `who`; installs the partnerContext.require fake through `setRequire`. `finish(ok)` commits / rolls back the request transaction. */
export function makeCtx(w: World, who: Who, over: Opts = {}) {
  w.opts = over;
  const staff = STAFFS[who];
  const pu = staff ? undefined : w.users.find((u) => u.id === U[who])!;
  const tenant = staff ? staff.tenant : pu!.tenant_id;
  const actor: any = staff ? { type: 'user', id: staff.id, membershipId: staff.membershipId } : { type: 'partner', id: pu!.id, membershipId: pu!.membership_id };
  const perms = staff ? staff.perms : PARTNER_PERMS;
  const tx = w.begin(actor, tenant);
  const nowIso = over.now ?? NOW;
  const record = (name: string, input: any, ctxArg: any) => w.portCalls.push({ name, input, ctxArg });
  const ctx: any = {
    tenantId: tenant, actor, requestId: id(99), tx, now: () => nowIso, db: { tx: async (fn: any) => fn(ctx) }, core: {},
    audit: { access: async () => undefined }, events: {}, uploads: {}, files: {}, storage: {}, services: {}, operationId: 'x', clientIp: '127.0.0.1', download: {},
    noRetry: () => undefined,
    log: { info: (o: object) => w.logs.push(JSON.stringify(o)), warn: (o: object) => w.logs.push(JSON.stringify(o)), error: (o: object) => w.logs.push(JSON.stringify(o)) },
    ports: {
      IdentityPort: {
        async assertRole(c: any, req: { permission: string }) {
          record('assertRole', req, c);
          if (over.deny === req.permission || !perms.includes(req.permission)) throw new LimsError('auth.forbidden');
        },
        async getTenantSettings(c: any, input: { keys?: string[] } = {}) {
          record('getTenantSettings', input, c);
          return { timezone: 'Asia/Kathmandu', calendarDisplay: 'BS' };
        },
      },
    },
  };
  /** per-ctx partnerContext.require (read by the vi.mock in the test file; per ctx so concurrent requests do not share state) */
  ctx.__require = async (c: any) => {
    if (c.actor?.type !== 'partner') throw new LimsError('auth.forbidden');
    const row = w.users.find((u) => u.tenant_id === c.tenantId && u.membership_id === c.actor.membershipId);
    const p = row && w.partners.find((x) => x.tenant_id === row.tenant_id && x.id === row.partner_id);
    if (!row || row.status === 'deactivated' || p?.status !== 'active') throw new LimsError('partners.partner_inactive');
    const r = Object.freeze({ partnerId: row.partner_id, partnerUserId: row.id, role: row.partner_role });
    c.partner = r;
    return r;
  };
  return { ctx, actor, tenant, finish: (ok: boolean) => (ok ? tx.commit() : tx.rollback()) };
}
