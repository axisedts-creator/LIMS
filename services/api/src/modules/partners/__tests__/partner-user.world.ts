// C13 T06 test fixture (not a test file): in-memory emulation of partners.partner_users / partners.partners over the `tx.query(text, values)` seam,
// plus IdentityPort / partnerContext fakes. Synthetic data only.
// The fake parses the writer's SQL (single-table statements) so the tests exercise the real WHERE clauses:
//   SELECT  : FROM partners.partner_users | partners.partners; WHERE equalities/IN/<>/ANY on tenant_id, partner_id, id, membership_id, status, partner_role
//             (`$n` params or 'literals'); `FOR UPDATE` is recorded; count(*) returns {<alias or count>: n}; no JOIN.
//   INSERT  : INSERT INTO partners.partner_users (cols) VALUES (...) [RETURNING ...] — one row, each value `$n`, 'literal', NULL or now().
//   UPDATE  : UPDATE partners.partner_users SET col = $n|'lit'|NULL|now()|col + 1, ... WHERE ... [RETURNING ...].
//   Table CHECKs/UNIQUE of 05-SCHEMA §3.2 are enforced; trigger partners.guard_partner_users (D-103) is emulated for partner actors.
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export const id = (n: number) => `01940e00-0000-7000-8000-c1306${String(n).padStart(7, '0')}`;
export const T_A = id(1), T_B = id(2);
export const P = { X: id(10), Y: id(11), Z: id(12), B: id(13) };
export const NOW = '2026-11-13T00:00:00.000Z';

export type Who = 'adminX' | 'adminX2' | 'memberX' | 'invitedX' | 'deactX' | 'adminY' | 'memberY' | 'adminZ' | 'adminB' | 'staff' | 'staffB' | 'staffNoManage';
export const U: Record<string, string> = { adminX: id(20), adminX2: id(21), memberX: id(22), invitedX: id(23), deactX: id(24), adminY: id(25), memberY: id(26), adminZ: id(27), adminB: id(28) };
export const M: Record<string, string> = { adminX: id(30), adminX2: id(31), memberX: id(32), invitedX: id(33), deactX: id(34), adminY: id(35), memberY: id(36), adminZ: id(37), adminB: id(38) };
export const STAFF = { id: id(50), membershipId: id(51) };
export const STAFF_B = { id: id(52), membershipId: id(53) };

const PRIVILEGED = ['partners.partner_user.manage', 'partners.partner.manage'];
const ADMIN_PERMS = ['partners.order.read', 'partners.manifest.submit', 'partners.partner_user.manage'];
const MEMBER_PERMS = ['partners.order.read', 'partners.manifest.submit'];
const STAFF_PERMS = ['partners.partner.read', 'partners.partner.manage'];

const pgErr = (code: string, message: string, constraint?: string) => Object.assign(new Error(message), { code, constraint });

export interface Opts {
  aal?: 'aal1' | 'aal2';
  provisionError?: unknown;
  updateError?: unknown;
  /** status returned by updatePartnerMembership(reactivate) */
  reactivateStatus?: 'active' | 'invited';
  /** emulate a permission bug: assertRole never refuses (service-level guard must still hold, D-103) */
  assertRoleAllowsAll?: boolean;
  /** role the partnerContext fake reports (default: the DB row's role) */
  roleOverride?: 'partner_admin' | 'partner_member';
  /** staff permission set (default manage + read) */
  staffPerms?: string[];
  /** every INSERT into partner_users fails (after the port succeeded) */
  failInsert?: boolean;
}

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, quote = false, cur = '';
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function makeWorld() {
  const partners: Row[] = [
    { id: P.X, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active' },
    { id: P.Y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active' },
    { id: P.Z, tenant_id: T_A, partner_code: 'SYN-Z', name: 'Synthetic Partner Z', status: 'suspended' },
    { id: P.B, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active' },
  ];
  const mk = (k: string, tenant: string, partner: string, role: string, status: string, version: number): Row => ({
    id: U[k], tenant_id: tenant, partner_id: partner, membership_id: M[k], partner_role: role, status, display_name: `Synthetic ${k}`,
    email_masked: 'u***@p***.invalid', activated_at: status === 'invited' ? null : NOW, deactivated_at: status === 'deactivated' ? NOW : null,
    deactivated_by: status === 'deactivated' ? STAFF.id : null, deactivate_reason_code: status === 'deactivated' ? 'left_organisation' : null,
    invited_by_actor_type: 'user', version, created_at: NOW, updated_at: NOW, created_by: STAFF.id, updated_by: STAFF.id,
  });
  const users: Row[] = [
    mk('adminX', T_A, P.X, 'partner_admin', 'active', 3), mk('adminX2', T_A, P.X, 'partner_admin', 'active', 1),
    mk('memberX', T_A, P.X, 'partner_member', 'active', 2), mk('invitedX', T_A, P.X, 'partner_member', 'invited', 1),
    mk('deactX', T_A, P.X, 'partner_member', 'deactivated', 4),
    mk('adminY', T_A, P.Y, 'partner_admin', 'active', 5), mk('memberY', T_A, P.Y, 'partner_member', 'active', 6),
    mk('adminZ', T_A, P.Z, 'partner_admin', 'active', 1), mk('adminB', T_B, P.B, 'partner_admin', 'active', 9),
  ];
  const memberships = new Map<string, { status: string; role: string }>(users.map((u) => [u.membership_id, { status: u.status, role: u.partner_role }]));
  const emails = new Set<string>();
  let seq = 100;
  const w = {
    partners, users, memberships, emails,
    rls: true, // emulate app.current_partner_id() / tenant RLS; false = a handler that forgets its own scoping gets no help
    opts: {} as Opts,
    events: [] as string[],
    sql: [] as Array<{ text: string; values: unknown[]; actor: string }>,
    portCalls: [] as Array<{ name: string; input: any; ctxArg: any }>,
    logs: [] as string[],
    assertCalls: [] as string[],
    next: () => id(seq++),
    snapshot: () => structuredClone({ users, memberships: [...memberships], emails: [...emails] }),
    restore(s: ReturnType<typeof structuredClone<any>>) {
      users.splice(0, users.length, ...s.users); memberships.clear(); for (const [k, v] of s.memberships) memberships.set(k, v);
      emails.clear(); for (const e of s.emails) emails.add(e);
    },
    writes: () => w.sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text)),
    portWrites: () => w.portCalls.filter((c) => c.name !== 'assertRole'),
    userByKey: (k: string) => users.find((u) => u.id === U[k])!,
    newTx: undefined as unknown as (actor: { type: string; id: string; membershipId?: string }, tenant: string) => any,
  };

  // ---------- conditions ----------
  const COLS = 'tenant_id|partner_id|id|membership_id|status|partner_role';
  function conds(text: string, values: unknown[]) {
    const where = /\bWHERE\b([\s\S]*)$/i.exec(text)?.[1] ?? '';
    const re = new RegExp(`\\b(?:\\w+\\.)?(${COLS})\\b\\s*(=\\s*ANY\\s*\\(\\s*\\$(\\d+)\\s*\\)|<>|!=|=|NOT\\s+IN|IN)\\s*(\\$(\\d+)(?:::\\w+)?|'[^']*'|\\([^)]*\\))?`, 'gi');
    const out: Array<{ col: string; op: string; val: unknown }> = [];
    for (let m; (m = re.exec(where)); ) {
      const col = m[1]!.toLowerCase(); const opRaw = m[2]!.replace(/\s+/g, ' ').toUpperCase();
      if (m[3] !== undefined && /ANY/.test(opRaw)) { out.push({ col, op: 'IN', val: values[Number(m[3]) - 1] }); continue; }
      const rhs = m[4]; if (rhs === undefined) continue;
      let val: unknown;
      if (rhs.startsWith('$')) val = values[Number(m[5]) - 1];
      else if (rhs.startsWith("'")) val = rhs.slice(1, -1);
      else val = splitTop(rhs.slice(1, -1)).map((x) => (x.startsWith('$') ? values[Number(x.slice(1)) - 1] : x.replace(/^'|'$/g, '')));
      out.push({ col, op: opRaw === '=' ? 'EQ' : opRaw === '<>' || opRaw === '!=' ? 'NE' : opRaw === 'IN' ? 'IN' : opRaw === 'NOT IN' ? 'NIN' : 'IN', val });
    }
    return out;
  }
  const matches = (row: Row, cs: ReturnType<typeof conds>) => cs.every(({ col, op, val }) => {
    const v = String(row[col]);
    if (op === 'EQ') return v === String(val);
    if (op === 'NE') return v !== String(val);
    const list = (Array.isArray(val) ? val : [val]).map(String);
    return op === 'IN' ? list.includes(v) : !list.includes(v);
  });

  function evalExpr(raw: string, values: unknown[], current?: Row, col?: string): unknown {
    const e = raw.trim().replace(/::\w+(\[\])?$/i, '');
    if (/^\$\d+$/.test(e)) return values[Number(e.slice(1)) - 1];
    if (/^'.*'$/.test(e)) return e.slice(1, -1).replace(/''/g, "'");
    if (/^NULL$/i.test(e)) return null;
    if (/^(now\(\)|current_timestamp|clock_timestamp\(\)|transaction_timestamp\(\))$/i.test(e)) return NOW;
    if (/^(true|false)$/i.test(e)) return e.toLowerCase() === 'true';
    if (/^\d+$/.test(e)) return Number(e);
    const inc = /^(?:\w+\.)?(\w+)\s*\+\s*1$/.exec(e);
    if (inc && current && inc[1] === col) return Number(current[col]) + 1;
    throw new Error(`fake SQL: unsupported expression "${raw}" (use $n params, 'literals', NULL, now(), col + 1)`);
  }

  // ---------- trigger guard_partner_users (D-103) + RLS ----------
  const callerOf = (actor: { type: string; membershipId?: string }) => (actor.type === 'partner' ? users.find((u) => u.membership_id === actor.membershipId) : undefined);
  const visible = (kind: 'pu' | 'p', row: Row, tenant: string, actor: { type: string; membershipId?: string }) => {
    if (!w.rls) return true;
    if (row.tenant_id !== tenant) return false;
    if (actor.type !== 'partner') return true;
    const c = callerOf(actor);
    return !!c && c.status !== 'deactivated' && (kind === 'pu' ? row.partner_id === c.partner_id : row.id === c.partner_id);
  };
  function guardPartnerUsers(actor: { type: string; membershipId?: string }, op: 'INSERT' | 'UPDATE', oldRow: Row | undefined, newRow: Row) {
    if (actor.type !== 'partner') return;
    const c = callerOf(actor);
    const ownFlip = op === 'UPDATE' && oldRow && c && oldRow.id === c.id && oldRow.status === 'invited' && newRow.status === 'active'
      && oldRow.partner_role === newRow.partner_role;
    if (ownFlip) return;
    if (c && c.status === 'active' && c.partner_role === 'partner_admin' && c.partner_id === newRow.partner_id) return;
    throw pgErr('P0001', 'immutable_row');
  }
  function check(row: Row, others: Row[]) {
    if (!['partner_admin', 'partner_member'].includes(row.partner_role)) throw pgErr('23514', 'role', 'partner_users__role__ck');
    if (!['invited', 'active', 'deactivated'].includes(row.status)) throw pgErr('23514', 'status', 'partner_users__status__ck');
    if (typeof row.display_name !== 'string' || row.display_name.length < 1 || row.display_name.length > 120) throw pgErr('23514', 'name', 'partner_users__name__ck');
    if (typeof row.email_masked !== 'string' || row.email_masked.length < 3 || row.email_masked.length > 64) throw pgErr('23514', 'email', 'partner_users__email__ck');
    if ((row.status === 'deactivated') !== (row.deactivated_at != null)) throw pgErr('23514', 'deact', 'partner_users__deact__ck');
    if (!['user', 'partner'].includes(row.invited_by_actor_type)) throw pgErr('23514', 'inviter', 'partner_users__inviter__ck');
    if (!row.tenant_id || !row.partner_id || !row.membership_id) throw pgErr('23502', 'not null');
    if (others.some((o) => o !== row && o.tenant_id === row.tenant_id && o.membership_id === row.membership_id)) throw pgErr('23505', 'dup membership', 'partner_users__tenant_id_membership_id__uq');
  }

  w.newTx = (actor: { type: string; id: string; membershipId?: string }, tenant: string) => {
    const tx = {
      startedAt: new Date(), operation: {},
      savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      async query(text: string, values: unknown[] = []) {
        w.sql.push({ text, values, actor: actor.type });
        w.events.push(`SQL ${text.replace(/\s+/g, ' ').trim()}`);
        if (/pg_advisory_xact_lock/i.test(text)) return { rows: [], rowCount: 0 };
        const ins = /^\s*INSERT\s+INTO\s+partners\.partner_users\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*(RETURNING[\s\S]*)?$/i.exec(text);
        if (ins) {
          if (w.opts.failInsert) throw pgErr('XX000', 'injected insert failure');
          const cols = ins[1]!.split(',').map((c) => c.trim().toLowerCase()); const vals = splitTop(ins[2]!);
          if (cols.length !== vals.length) throw new Error('fake SQL: INSERT column/value count mismatch');
          const row: Row = { id: w.next(), version: 1, activated_at: null, deactivated_at: null, deactivated_by: null, deactivate_reason_code: null, created_at: NOW, updated_at: NOW };
          cols.forEach((c, i) => { row[c] = evalExpr(vals[i]!, values); });
          if (w.rls && row.tenant_id !== tenant) throw pgErr('42501', 'rls tenant');
          guardPartnerUsers(actor, 'INSERT', undefined, row);
          check(row, users);
          users.push(row);
          return { rows: ins[3] ? [{ ...row }] : [], rowCount: 1 };
        }
        const upd = /^\s*UPDATE\s+partners\.partner_users\s+(?:\w+\s+)?SET\s+([\s\S]*?)\s+WHERE\b([\s\S]*)$/i.exec(text);
        if (upd) {
          const returning = /\bRETURNING\b/i.test(text);
          const cs = conds(`WHERE ${upd[2]!.replace(/\bRETURNING\b[\s\S]*$/i, '')}`, values);
          const targets = users.filter((u) => matches(u, cs) && visible('pu', u, tenant, actor));
          const sets = splitTop(upd[1]!);
          for (const t of targets) {
            const nu = { ...t };
            for (const s of sets) {
              const m = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(s)!;
              nu[m[1]!.toLowerCase()] = evalExpr(m[2]!, values, t, m[1]!.toLowerCase());
            }
            guardPartnerUsers(actor, 'UPDATE', t, nu);
            check(nu, users.filter((u) => u !== t));
            Object.assign(t, nu);
          }
          return { rows: returning ? targets.map((t) => ({ ...t })) : [], rowCount: targets.length };
        }
        const sel = /\bFROM\s+partners\.(partner_users|partners)\b/i.exec(text);
        if (/^\s*SELECT\b/i.test(text) && sel) {
          const kind = sel[1]!.toLowerCase() === 'partners' ? 'p' : 'pu';
          if (/\bJOIN\b/i.test(text)) throw new Error('fake SQL: JOIN unsupported (single-table selects only)');
          const rows = (kind === 'p' ? partners : users).filter((r) => matches(r, conds(text, values)) && visible(kind, r, tenant, actor));
          const count = /\bcount\s*\(/i.exec(text);
          if (count) {
            const alias = /\bcount\s*\([^)]*\)\s*(?:::\w+)?\s*(?:AS\s+)?(\w+)?/i.exec(text)?.[1];
            const n = /count\s*\([^)]*\)\s*::\s*(int|integer)/i.test(text) ? rows.length : String(rows.length);
            return { rows: [{ [alias && !/^(FROM|WHERE)$/i.test(alias) ? alias : 'count']: n }], rowCount: 1 };
          }
          return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
        }
        throw new Error(`fake SQL: unexpected statement in partner-user flow: ${text}`);
      },
    };
    return tx;
  };
  return w;
}
export type World = ReturnType<typeof makeWorld>;

/** Builds ctx + IdentityPort fake for `who`; also installs the partnerContext.require fake through `setRequire`. */
export function makeCtx(w: World, who: Who, setRequire: (fn: (ctx: any) => Promise<unknown>) => void, over: Opts = {}) {
  w.opts = over;
  const isStaff = who === 'staff' || who === 'staffB' || who === 'staffNoManage';
  const pu = isStaff ? undefined : w.users.find((u) => u.id === U[who])!;
  const tenant = who === 'staffB' ? T_B : pu ? pu.tenant_id : T_A;
  const actor: any = isStaff
    ? { type: 'user', id: (who === 'staffB' ? STAFF_B : STAFF).id, membershipId: (who === 'staffB' ? STAFF_B : STAFF).membershipId }
    : { type: 'partner', id: pu!.id, membershipId: pu!.membership_id };
  const aal = over.aal ?? 'aal2';
  const perms = isStaff ? (who === 'staffNoManage' ? ['partners.partner.read'] : over.staffPerms ?? STAFF_PERMS)
    : pu!.partner_role === 'partner_admin' ? ADMIN_PERMS : MEMBER_PERMS;
  const tx = w.newTx(actor, tenant);
  const ctx: any = {
    tenantId: tenant, actor, requestId: id(99), tx, now: () => NOW, db: { tx: async (fn: any) => fn(ctx) }, core: {},
    audit: { access: async () => undefined }, events: {}, uploads: {}, files: {}, storage: {}, services: {}, operationId: 'x', clientIp: '127.0.0.1', download: {},
    noRetry: () => undefined,
    log: { info: (o: object) => w.logs.push(JSON.stringify(o)), warn: (o: object) => w.logs.push(JSON.stringify(o)), error: (o: object) => w.logs.push(JSON.stringify(o)) },
    ports: {
      IdentityPort: {
        async assertRole(c: unknown, req: { permission: string }) {
          w.events.push(`ASSERT ${req.permission}`); w.assertCalls.push(req.permission); w.portCalls.push({ name: 'assertRole', input: req, ctxArg: c });
          if (over.assertRoleAllowsAll) return;
          if (!perms.includes(req.permission)) throw new LimsError('auth.forbidden');
          if (PRIVILEGED.includes(req.permission) && aal !== 'aal2') throw new LimsError('auth.mfa_required');
        },
        async provisionPartnerMembership(c: unknown, input: any) {
          w.events.push('PORT provisionPartnerMembership'); w.portCalls.push({ name: 'provisionPartnerMembership', input, ctxArg: c });
          if (over.provisionError) throw over.provisionError;
          const key = String(input.email).toLowerCase();
          if (w.emails.has(key)) throw new LimsError('identity.user_exists');
          w.emails.add(key);
          const membershipId = w.next();
          w.memberships.set(membershipId, { status: 'invited', role: input.partnerRole });
          return { membershipId, userId: w.next(), invitationId: w.next(), status: 'invited' as const };
        },
        async updatePartnerMembership(c: unknown, input: any) {
          w.events.push(`PORT updatePartnerMembership:${input.action}`); w.portCalls.push({ name: 'updatePartnerMembership', input, ctxArg: c });
          if (over.updateError) throw over.updateError;
          const m = w.memberships.get(input.membershipId);
          if (!m) throw new LimsError('common.not_found');
          if (input.action === 'deactivate') m.status = 'deactivated';
          else if (input.action === 'reactivate') m.status = over.reactivateStatus ?? 'active';
          else if (input.action === 'set_role') m.role = input.partnerRole;
          return { membershipId: input.membershipId, status: m.status as 'invited' | 'active' | 'deactivated', version: 100 };
        },
      },
    },
  };
  setRequire(async (c: any) => {
    if (c.actor?.type !== 'partner') throw new LimsError('auth.forbidden');
    const row = w.users.find((u) => u.tenant_id === c.tenantId && u.membership_id === c.actor.membershipId);
    const p = row && w.partners.find((x) => x.tenant_id === row.tenant_id && x.id === row.partner_id);
    if (!row || row.status === 'deactivated' || p?.status !== 'active') throw new LimsError('partners.partner_inactive');
    const ref = Object.freeze({ partnerId: row.partner_id, partnerUserId: row.id, role: over.roleOverride ?? row.partner_role });
    c.partner = ref;
    return ref;
  });
  return { ctx, actor, tenant };
}
