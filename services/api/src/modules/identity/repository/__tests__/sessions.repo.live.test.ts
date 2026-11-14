// T4 live-DB integration + bench (done_when "tests": revoked/idle/absolute/locked/suspended/IP denied; p95 <= 3 ms at 500 rps).
// Gated like core/ratelimit/__tests__/backends.test.ts: skipped unless LIMS_TEST_DATABASE_URL is set.
//   LIMS_TEST_DATABASE_URL      superuser URL of a migrated + seeded DB (same preconditions as db/tests/identity/T0B-10.C2_lookups.test.sql:
//                               tenant 01a1a98a-ac40-7000-8000-00000000a001, user ...a300, membership ...a500 exist). Used only to seed/restore.
//   LIMS_TEST_API_DATABASE_URL  optional lims_api URL the resolver runs as (default: the superuser URL; use lims_api to prove FORCE RLS + DEFINER).
// Needs the `pg` driver (not a services/api dependency yet; loaded dynamically so this file typechecks and skips without it).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../core/db/tx.js';
import { createClaimsResolver } from '../../claims/resolver.js';

const URL_ = process.env['LIMS_TEST_DATABASE_URL'];
const API_URL = process.env['LIMS_TEST_API_DATABASE_URL'] ?? URL_;
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', SUB = '01a1a98a-ac40-7000-8000-00000000a300', MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c200-0000-7000-8000-${String(n).padStart(12, '0')}`;
const H = (s: string) => `\\x${createHash('sha256').update(s).digest('hex')}`; // distinct synthetic 32-byte tokens (sessions__token_len__ck)
const REQ = '01a1a98a-ac40-7000-8000-00000000c001';
const request = (o: object = {}) => ({ clientIp: '203.0.113.7', requestId: REQ, endpointFamily: 'staff' as const, bffKey: 'staff_web' as const, ...o });
const jwtFor = (n: number, aal: 'aal1' | 'aal2' = 'aal1') => ({ sub: SUB, sessionId: uid(9000 + n), aal, exp: 1_900_000_000, iat: 1_899_990_000 });
const sessionRow = (n: number, o: Record<string, unknown> = {}) => ({
  id: uid(8000 + n), tenant_id: TENANT, kind: 'tenant_staff', user_id: SUB, membership_id: MEMBERSHIP, gotrue_session_id: uid(9000 + n),
  token_sha256: H(`t${n}`), previous_token_sha256: null, state: 'active', aal: 'aal1', refresh_token_enc: '\\x01', access_token_enc: '\\x01', enc_key_id: 'k1',
  access_expires_at: new Date(Date.now() + 3_600_000).toISOString(), idle_timeout_minutes: 30, idle_expires_at: new Date(Date.now() + 1_800_000).toISOString(),
  absolute_expires_at: new Date(Date.now() + 39_600_000).toISOString(), expires_at: new Date(Date.now() + 43_200_000).toISOString(), created_by: SYS, updated_by: SYS, ...o,
});

describe.skipIf(!URL_)('claimsResolver over a real DB (identity_resolve_session DEFINER)', () => {
  let admin: any, apiPool: any, resolver: ReturnType<typeof createClaimsResolver>;
  const cleanup: string[] = [];

  /** Run SQL as one committed transaction with system claims (audit triggers need them), parameterised by [text, values]. */
  async function seed(stmts: Array<[string, unknown[]?]>) {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      for (const [text, values] of stmts) await c.query(text, values);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  const insertSession = (row: Record<string, unknown>): [string, unknown[]] => [
    `INSERT INTO identity.sessions SELECT * FROM jsonb_populate_record(NULL::identity.sessions, $1::jsonb)`, [JSON.stringify(row)]];
  const addSession = async (n: number, o: Record<string, unknown> = {}, extra: Array<[string, unknown[]?]> = []) => {
    cleanup.push(`DELETE FROM identity.sessions WHERE id = '${uid(8000 + n)}'`);
    await seed([...extra, insertSession(sessionRow(n, o))]);
  };

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join('')); // variable specifier: no static type/dependency on the driver
    const Pool = (pg.default ?? pg).Pool;
    admin = new Pool({ connectionString: URL_, max: 2 });
    apiPool = new Pool({ connectionString: API_URL, max: 20 });
    resolver = createClaimsResolver({ db: createDb({ pool: apiPool, identitySystemActorId: SYS }) });
  });
  afterAll(async () => {
    for (const sql of cleanup.reverse()) await seed([[sql]]);
    await seed([
      [`UPDATE core.memberships SET locked_at = NULL, locked_by = NULL, lock_reason_code = NULL WHERE id = $1`, [MEMBERSHIP]],
      [`UPDATE core.tenants SET status = 'active', suspended_at = NULL WHERE id = $1`, [TENANT]],
    ]);
    await admin?.end(); await apiPool?.end();
  });

  it('accepts a live tenant_staff session: tenant claims from the DB row', async () => {
    await addSession(1);
    const r = await resolver.resolve(jwtFor(1), request());
    expect(r.kind).toBe('tenant');
    expect(JSON.parse((r as any).claimsJson)).toMatchObject({ sub: SUB, tenant_id: TENANT, membership_id: MEMBERSHIP, lims_session_id: uid(8001), aal: 'aal1' });
  });
  it('unknown / foreign-sub session -> auth.unauthenticated', async () => {
    expect(await resolver.resolve(jwtFor(404), request())).toEqual({ kind: 'rejected', code: 'auth.unauthenticated' });
  });
  it('revoked -> auth.session_expired', async () => {
    await addSession(2, { state: 'revoked', revoked_at: new Date().toISOString(), revoke_reason: 'logout' });
    expect(await resolver.resolve(jwtFor(2), request())).toEqual({ kind: 'rejected', code: 'auth.session_expired' });
  });
  it('idle-expired -> auth.session_expired', async () => {
    await addSession(3, { idle_expires_at: new Date(Date.now() - 60_000).toISOString() });
    expect(await resolver.resolve(jwtFor(3), request())).toEqual({ kind: 'rejected', code: 'auth.session_expired' });
  });
  it('absolute-expired -> auth.session_expired', async () => {
    await addSession(4, { absolute_expires_at: new Date(Date.now() - 60_000).toISOString() });
    expect(await resolver.resolve(jwtFor(4), request())).toEqual({ kind: 'rejected', code: 'auth.session_expired' });
  });
  it('locked membership -> auth.account_locked', async () => {
    await addSession(5, {}, [[`UPDATE core.memberships SET locked_at = now(), locked_by = $1, lock_reason_code = 'security_concern' WHERE id = $2`, [SYS, MEMBERSHIP]]]);
    try { expect(await resolver.resolve(jwtFor(5), request())).toEqual({ kind: 'rejected', code: 'auth.account_locked' }); }
    finally { await seed([[`UPDATE core.memberships SET locked_at = NULL, locked_by = NULL, lock_reason_code = NULL WHERE id = $1`, [MEMBERSHIP]]]); }
  });
  it('suspended tenant -> identity.tenant_suspended', async () => {
    await addSession(6, {}, [[`UPDATE core.tenants SET status = 'suspended', suspended_at = now() WHERE id = $1`, [TENANT]]]);
    try { expect(await resolver.resolve(jwtFor(6), request())).toEqual({ kind: 'rejected', code: 'identity.tenant_suspended' }); }
    finally { await seed([[`UPDATE core.tenants SET status = 'active', suspended_at = NULL WHERE id = $1`, [TENANT]]]); }
  });
  it('platform staff IP outside allowed_cidrs -> identity.platform_ip_denied; inside -> platform claims', async () => {
    const staff = uid(7001), user = uid(7101);
    cleanup.push(`DELETE FROM identity.platform_staff WHERE id = '${staff}'`); // runs after the session delete (reverse order)
    await seed([[`INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, allowed_cidrs, created_by, updated_by)
                  VALUES ($1, $2, 'platform.live@synthetic.example', 'Synthetic Live', 'platform_support', '{198.51.100.0/24}', $3, $3)`, [staff, user, SYS]]]);
    await addSession(7, { tenant_id: null, kind: 'platform', user_id: user, membership_id: null, platform_staff_id: staff, aal: 'aal2' });
    const j = { ...jwtFor(7, 'aal2'), sub: user };
    expect(await resolver.resolve(j, request({ clientIp: '203.0.113.7' }))).toEqual({ kind: 'rejected', code: 'identity.platform_ip_denied' });
    const ok = await resolver.resolve(j, request({ clientIp: '198.51.100.9' }));
    expect(ok.kind).toBe('platform');
  });

  it('bench: p95 <= 3 ms at 500 rps (open-loop, 4 s, after warm-up)', async () => {
    await addSession(8);
    const j = jwtFor(8);
    for (let i = 0; i < 200; i++) await resolver.resolve(j, request());
    const total = 2000, gapMs = 2, lat: number[] = [], t0 = performance.now(), jobs: Promise<void>[] = [];
    for (let i = 0; i < total; i++) {
      const due = t0 + i * gapMs;
      const wait = due - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      const s = performance.now();
      jobs.push(resolver.resolve(j, request()).then((r) => { lat.push(performance.now() - s); expect(r.kind).toBe('tenant'); }));
    }
    await Promise.all(jobs);
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)]!;
    console.log(`T4 bench: n=${lat.length} p50=${lat[lat.length >> 1]!.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${lat[Math.floor(lat.length * 0.99)]!.toFixed(2)}ms`);
    expect(p95).toBeLessThanOrEqual(3);
  }, 60_000);
});
