// T0B-LOGIN-1 / LD-300: the session row a login builds must satisfy sessions__absolute__ck and sessions__idle__ck (05-SCHEMA identity.sessions, 04 A8, 08 R10):
//   absolute_expires_at <= created_at + 12 h (kind <> patient), created_at = the DATABASE now() unless the INSERT passes it;
//   idle_timeout_minutes 15..30 (tenant_staff, platform, partner), 60..720 (staff_mobile); expires_at = the clamped absolute.
// Live fault 2026-11-17 00:04 NPT: tenant default (idle 15, absolute 12) -> app clock now + 12 h > db now() + 12 h by the clock gap -> 23514 -> 400.
// Two layers, both implementation-agnostic (the fix may clamp in SQL with least(.., now() + interval '12 hours') or pass created_at):
//   A  service: values handed to repo.insertSession for every login family, tenant settings outside what a session can hold (the OpenAPI ranges 1..1440 / 1..168).
//   B  real SQL text: the statement createAuthRepo().insertSession really sends (SESSION_SQL / APP_SESSION_SQL), evaluated by `evalInsert` below against the
//      constraint expressions copied from db/migrations/20261105001300_identity__create_identity_schema.sql, with the database clock BEHIND the application clock.
// No real Postgres is needed (the repo has no embedded one; the live sweep is T0B-SWEEP-1/2). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { createAuthRepo } from '../../repository/auth-events.repo.js';
import { createAuthService } from '../auth.service.js';
import { START, MEMB_A, TENANT_A, idN, makeWorld, tenantRow, platformRow, PASSWORD, EMAIL, type LoginRow } from './auth.helpers.js';

const H = 3_600_000, MIN = 60_000;
const input = { email: EMAIL, password: PASSWORD };
const partnerRow = (o: LoginRow = {}) => tenantRow({ actor_type: 'partner', partner_role: 'partner_admin', ...o });
const APP = { appInstanceId: idN(0x7001), appPlatform: 'android' as const };

type Fam = 'staff' | 'partner' | 'mobile' | 'platform';
/** run one login of the family through the real auth.service with the in-memory world; return the session handed to the repo and the world clock */
async function loginAs(fam: Fam, row: LoginRow, deps: Record<string, unknown> = {}) {
  const w = makeWorld({ rows: fam === 'platform' ? { [idN(0xa300)]: platformRow(row) } : { [idN(0xa300)]: row } });
  (w.deps.repo as any).membershipHasPermission = async () => true;
  const svc = createAuthService({ ...w.deps, ...deps } as any) as any;
  const k = w.makeCtx(fam === 'partner' ? { bffKey: 'partner' } : {});
  if (fam === 'partner') await svc.loginPartner(k.ctx, input);
  else if (fam === 'mobile') await svc.openMobileSession(k.ctx, { ...input, ...APP });
  else await svc.loginStaff(k.ctx, input);
  const s = (fam === 'platform' ? w.repo.by('insertPlatformSession') : w.repo.by('insertSession'))[0];
  return { s, now: START };
}

// ---------------- B: a small evaluator of the INSERT text (VALUES or SELECT form) over the clocks ----------------
const top = (s: string, sep: string) => {   // split at top level (outside parens and quotes)
  const out: string[] = []; let d = 0, q = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") q = !q;
    if (!q && c === '(') d++;
    if (!q && c === ')') d--;
    if (!q && d === 0 && s.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; continue; }
    cur += c;
  }
  out.push(cur); return out;
};
function ev(expr: string, p: unknown[], dbNow: number): number | string | null {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')') && top(e.slice(1, -1), ',').length === 1 && top(e, ' + ').length === 1) e = e.slice(1, -1).trim();
  e = e.replace(/::[a-z_]+(\[\])?\s*$/i, '').trim();
  const sum = top(e, ' + ');
  if (sum.length > 1) return sum.map((x) => Number(ev(x, p, dbNow))).reduce((a, b) => a + b, 0);
  let m: RegExpMatchArray | null;
  if ((m = e.match(/^interval\s+'(\d+)\s+(hour|hours|minute|minutes|day|days)'$/i))) return Number(m[1]) * (/^h/i.test(m[2]!) ? H : /^m/i.test(m[2]!) ? MIN : 24 * H);
  if (/^(now|transaction_timestamp|statement_timestamp|clock_timestamp)\(\)$/i.test(e)) return dbNow;
  if ((m = e.match(/^\$(\d+)$/))) { const v = p[Number(m[1]) - 1]; return v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : (v as number | string | null); }
  if ((m = e.match(/^(least|greatest)\((.*)\)$/is))) { const a = top(m[2]!, ',').map((x) => Number(ev(x, p, dbNow))); return m[1]!.toLowerCase() === 'least' ? Math.min(...a) : Math.max(...a); }
  if (/^nullif\(/i.test(e)) return 'x';
  if (/^'.*'$/.test(e) || /^-?\d+$/.test(e)) return e;
  throw new Error(`evalInsert: cannot evaluate ${e}`);
}
function evalInsert(sql: string, p: unknown[], dbNow: number) {
  const m = sql.match(/INSERT INTO identity\.sessions\s*\(([^)]*)\)\s*(?:VALUES\s*\(([\s\S]*)\)|SELECT\s+([\s\S]*?))\s*(?:RETURNING[\s\S]*)?;?\s*$/i);
  if (!m) throw new Error(`evalInsert: not an INSERT into identity.sessions: ${sql.slice(0, 80)}`);
  const cols = m[1]!.split(',').map((c) => c.trim()); const vals = top((m[2] ?? m[3])!, ',');
  if (cols.length !== vals.length) throw new Error(`evalInsert: ${cols.length} columns, ${vals.length} values`);
  const row: Record<string, number | string | null> = {}; cols.forEach((c, i) => { row[c] = ev(vals[i]!, p, dbNow); });
  if (row['created_at'] === undefined) row['created_at'] = dbNow;   // column default now()
  return row;
}
/** the CHECK expressions of identity.sessions, verbatim from the migration (04 A8, 08 R10); returns the names of the violated constraints */
function violated(r: Record<string, number | string | null>): string[] {
  const kind = r['kind'], idle = Number(r['idle_timeout_minutes']), abs = Number(r['absolute_expires_at']), created = Number(r['created_at']), v: string[] = [];
  const idleOk = (['tenant_staff', 'platform', 'partner'].includes(String(kind)) && idle >= 15 && idle <= 30) || (kind === 'patient' && idle >= 1440 && idle <= 43200) || (kind === 'staff_mobile' && idle >= 60 && idle <= 720);
  const absOk = (kind !== 'patient' && abs <= created + 12 * H) || (kind === 'patient' && abs <= created + 90 * 24 * H);
  if (!idleOk) v.push('sessions__idle__ck'); if (!absOk) v.push('sessions__absolute__ck');
  if (Number(r['expires_at']) !== abs) v.push('expires_at != absolute_expires_at (LD-300)');
  return v;
}
const seal = (plain: string) => ({ keyId: 'k1', enc: Buffer.from(plain) });
/** the statement the REAL repo sends for this session, with the db clock `skewMs` behind the application clock (positive = app ahead, as on Render vs Supabase) */
async function insertViolations(s: any, skewMs: number) {
  const calls: Array<{ sql: string; p: unknown[] }> = [];
  await createAuthRepo({ seal }).insertSession({ query: async (sql: string, p: unknown[]) => { calls.push({ sql, p }); return { rows: [] }; } } as any, s);
  expect(calls).toHaveLength(1);
  return violated(evalInsert(calls[0]!.sql, calls[0]!.p, START.getTime() - skewMs));
}
const SKEWS = [0, 1, 250, 5_000, 60_000, -5_000];   // ms; 0 = clocks equal, > 0 = application ahead of the database (the live case), < 0 = database ahead

describe('LD-300 B: the real INSERT (SESSION_SQL / APP_SESSION_SQL) against sessions__absolute__ck / sessions__idle__ck', () => {
  it('evaluator self-check: the live fault is reproduced by the old shape (absolute = app now + 12 h, created_at defaulted to the earlier db now)', () => {
    const base = { kind: 'tenant_staff', idle_timeout_minutes: 15, absolute_expires_at: START.getTime() + 12 * H, expires_at: START.getTime() + 12 * H };
    expect(violated({ ...base, created_at: START.getTime() - 5 })).toEqual(['sessions__absolute__ck']);
    expect(violated({ ...base, created_at: START.getTime() })).toEqual([]);
    expect(violated({ ...base, idle_timeout_minutes: 1440, created_at: START.getTime() })).toEqual(['sessions__idle__ck']);
    expect(evalInsert('INSERT INTO identity.sessions (kind, absolute_expires_at) VALUES ($1, least($2, now() + interval \'12 hours\'))', ['tenant_staff', new Date(START.getTime() + 13 * H)], START.getTime())['absolute_expires_at']).toBe(START.getTime() + 12 * H);
  });

  for (const skew of SKEWS) {
    it(`tenant_staff, tenant defaults (idle 15, absolute 12): the row passes both checks with the application clock ${skew} ms ahead of the database clock [FAILS ON MAIN for skew > 0]`, async () => {
      const { s } = await loginAs('staff', tenantRow({ idle_timeout_minutes: 15, absolute_session_hours: 12 }));
      expect(await insertViolations(s, skew)).toEqual([]);
    });
  }
  for (const [name, fam, row, deps] of [
    ['tenant_staff idle 30 absolute 12', 'staff', tenantRow({ idle_timeout_minutes: 30, absolute_session_hours: 12 }), {}],
    ['tenant_staff absolute 11 (the founder workaround stays valid)', 'staff', tenantRow({ idle_timeout_minutes: 15, absolute_session_hours: 11 }), {}],
    ['tenant_staff in mfa_pending (verified factor)', 'staff', tenantRow({ has_verified_factor: true }), {}],
    ['partner (loginPartner)', 'partner', partnerRow({ idle_timeout_minutes: 15, absolute_session_hours: 12 }), {}],
    ['staff_mobile (openMobileSession, 12 h default)', 'mobile', tenantRow({ idle_timeout_minutes: 15, absolute_session_hours: 12 }), {}],
    ['staff_mobile with LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS 12 explicit', 'mobile', tenantRow(), { mobileAbsoluteHours: 12 }],
  ] as Array<[string, Fam, LoginRow, Record<string, unknown>]>) {
    it(`${name}: passes both checks with the application clock 5 s and 250 ms ahead of the database [FAILS ON MAIN]`, async () => {
      const { s } = await loginAs(fam, row, deps);
      expect(s.kind).toBe(fam === 'partner' ? 'partner' : fam === 'mobile' ? 'staff_mobile' : 'tenant_staff');
      expect(await insertViolations(s, 5_000)).toEqual([]);
      expect(await insertViolations(s, 250)).toEqual([]);
    });
  }
  it('settings the OpenAPI schema still admits (idle 1 / 1440, absolute 24 / 168) never reach the INSERT out of range (every family, any skew)', async () => {
    for (const [fam, row] of [['staff', tenantRow({ idle_timeout_minutes: 1440, absolute_session_hours: 168 })], ['staff', tenantRow({ idle_timeout_minutes: 1, absolute_session_hours: 1 })],
      ['partner', partnerRow({ idle_timeout_minutes: 1440, absolute_session_hours: 168 })], ['mobile', tenantRow({ idle_timeout_minutes: 1440, absolute_session_hours: 168 })]] as Array<[Fam, LoginRow]>) {
      const { s } = await loginAs(fam, row);
      for (const skew of [0, 5_000, -5_000]) expect(await insertViolations(s, skew), `${fam} idle ${row['idle_timeout_minutes']} abs ${row['absolute_session_hours']} skew ${skew}`).toEqual([]);
    }
  });
});

describe('LD-300 A: service clamp, every login family (done_when 2 and 3)', () => {
  const STAFF_IDLE = [[1, 15], [5, 15], [14, 15], [15, 15], [22, 22], [30, 30], [31, 30], [60, 30], [1440, 30]];
  for (const [set, want] of STAFF_IDLE) {
    it(`loginStaff: tenant idle ${set} min -> session idle ${want} min, idle_expires_at = now + ${want} min [FAILS ON MAIN when ${set} != ${want}]`, async () => {
      const { s, now } = await loginAs('staff', tenantRow({ idle_timeout_minutes: set, absolute_session_hours: 12 }));
      expect(s.idleTimeoutMinutes).toBe(want); expect(s.idleExpiresAt.getTime()).toBe(now.getTime() + want * MIN);
    });
  }
  it('loginPartner: idle clamped to 15..30 like staff (idle 1440 -> 30, 1 -> 15)', async () => {
    expect((await loginAs('partner', partnerRow({ idle_timeout_minutes: 1440 }))).s.idleTimeoutMinutes).toBe(30);
    expect((await loginAs('partner', partnerRow({ idle_timeout_minutes: 1 }))).s.idleTimeoutMinutes).toBe(15);
  });
  it('platform: LIMS_IDENTITY_PLATFORM_IDLE_MINUTES / _ABSOLUTE_HOURS out of range are clamped too (idle 5 -> 15, 90 -> 30; absolute 24 -> 12); the 15 / 8 defaults are unchanged', async () => {
    const lo = (await loginAs('platform', {}, { platformIdleMinutes: 5, platformAbsoluteHours: 8 })).s; expect(lo.idleTimeoutMinutes).toBe(15);
    const hi = (await loginAs('platform', {}, { platformIdleMinutes: 90, platformAbsoluteHours: 24 })).s; expect(hi.idleTimeoutMinutes).toBe(30);
    expect(hi.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(START.getTime() + 12 * H); expect(hi.expiresAt.getTime()).toBe(hi.absoluteExpiresAt.getTime());
    const d = (await loginAs('platform', {})).s; expect(d.idleTimeoutMinutes).toBe(15); expect(d.absoluteExpiresAt.getTime()).toBe(START.getTime() + 8 * H);
  });
  const ABS = [[1, 1], [8, 8], [11, 11], [12, 12], [13, 12], [24, 12], [168, 12]];
  for (const [set, want] of ABS) {
    for (const fam of ['staff', 'partner'] as const) {
      it(`${fam}: tenant absolute ${set} h -> at most 12 h (here ${want} h); expires_at = absolute [FAILS ON MAIN when ${set} > 12]`, async () => {
        const { s, now } = await loginAs(fam, (fam === 'staff' ? tenantRow : partnerRow)({ idle_timeout_minutes: 15, absolute_session_hours: set }));
        expect(s.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(now.getTime() + 12 * H);
        expect(s.absoluteExpiresAt.getTime()).toBe(now.getTime() + want * H);
        expect(s.expiresAt.getTime()).toBe(s.absoluteExpiresAt.getTime());
      });
    }
  }
  it('staff_mobile: absolute from LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS (out of 1..12 -> 12), idle = absolute in minutes (60..720), expires_at = absolute; tenant idle/absolute settings do not apply', async () => {
    for (const [hours, want] of [[12, 12], [8, 8], [1, 1], [24, 12], [0, 12]]) {
      const { s, now } = await loginAs('mobile', tenantRow({ idle_timeout_minutes: 30, absolute_session_hours: 3 }), { mobileAbsoluteHours: hours });
      expect(s.idleTimeoutMinutes).toBe(want * 60); expect(s.absoluteExpiresAt.getTime()).toBe(now.getTime() + want * H); expect(s.expiresAt.getTime()).toBe(s.absoluteExpiresAt.getTime());
      expect(s.idleTimeoutMinutes).toBeGreaterThanOrEqual(60); expect(s.idleTimeoutMinutes).toBeLessThanOrEqual(720);
    }
  });
  it('the response agrees with the row: loginStaff absolute_expires_at / idle_expires_at in the body are the clamped values', async () => {
    const w = makeWorld({ rows: { [idN(0xa300)]: tenantRow({ idle_timeout_minutes: 1440, absolute_session_hours: 168 }) } });
    const r: any = await createAuthService(w.deps as any).loginStaff(w.makeCtx().ctx, input as any);
    expect(r.body.session.idle_expires_at).toBe(new Date(START.getTime() + 30 * MIN).toISOString());
    expect(r.body.session.absolute_expires_at).toBe(new Date(START.getTime() + 12 * H).toISOString());
  });
  it('GUARD (passes today): the default tenant row keeps absolute = now + 12 h exactly and idle 15 = now + 15 min; session bound to the tenant and membership', async () => {
    const { s, now } = await loginAs('staff', tenantRow({ idle_timeout_minutes: 15, absolute_session_hours: 12 }));
    expect(s).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A, kind: 'tenant_staff', idleTimeoutMinutes: 15 });
    expect(s.idleExpiresAt.getTime()).toBe(now.getTime() + 15 * MIN); expect(s.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(now.getTime() + 12 * H);
  });
  it('GUARD (passes today): missing / zero tenant settings are still common.internal, no session row (no silent default)', async () => {
    const w = makeWorld({ rows: { [idN(0xa300)]: tenantRow({ idle_timeout_minutes: null, absolute_session_hours: null }) } });
    await expect(createAuthService(w.deps as any).loginStaff(w.makeCtx().ctx, input as any)).rejects.toMatchObject({ code: 'common.internal' });
    expect(w.repo.by('insertSession')).toHaveLength(0);
  });
});
