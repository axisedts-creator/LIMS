// AUTH-MFA-COMPLETE-1 (LD-221, AUTH-SENSITIVE LD-189; C2 03-APP-FLOW SS7 platform_mfa_enrolled, 05-SCHEMA s4.10 platform_events, s5.4; 08 A28.1, A25 D-215, A12.1 app.pre_* GUCs):
// live defect: completeMfaEnrolment (platform) did a PLAIN INSERT into identity.platform_events as the system actor inside identityAuthTx -> the table is FORCE RLS, platform_events__insert__platform needs
// platform claims at aal2 (the session is aal1 at this step) and platform_events__insert__owner_only admits only bootstrap_admin_created -> 42501 -> mapDbError 404 common.not_found.
// Required: ONE new DEFINER + ONE additive owner policy; repo method recordPlatformMfaEnrolledEvent calls the DEFINER; recordPlatformEvent stays unchanged for any other caller.
// Seams fixed here (the writer matches them or raises a dispute):
//   repo.recordPlatformMfaEnrolledEvent(tx, { id, userId, platformStaffId, detail, requestId, clientIp, actorId }) -> ONE statement
//     `SELECT app.identity_platform_auth_write_mfa_enrolled_event($1::uuid, $2::jsonb) AS n` with params [userId, JSON.stringify(row)], row = { id, event_type: 'platform_mfa_enrolled', target_type: 'platform_staff',
//     target_id = actor_platform_staff_id = platformStaffId, detail (a nested JSON object), request_id, client_ip, created_by = actorId } (+ target_tenant_id null); result read like every integer DEFINER (n < 1 / no row -> common.internal).
//   the migration holds exactly: one CREATE FUNCTION + one CREATE POLICY platform_events__insert__owner_mfa_enrolled; the inventory row lists touches [identity.platform_events INSERT, identity.platform_staff SELECT]
//     and policies [platform_events__insert__owner_mfa_enrolled, platform_staff__select__owner_only] (the same row as db/tests/isolation/_registry.sql).
// Live SQL behaviour = pgTAP db/tests/identity/AUTH-MFA-COMPLETE-1_platform_event.test.sql (NOT run in the lane; the migration was NOT run either). The static tests below read the files only.
// Expected now: the method tests fail (no method); the migration + inventory static tests fail (files / row missing); the "only the new function" source test fails (handler still calls recordPlatformEvent).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { sealerFromEnv } from '../auth-events.repo.js';
import { createMfaRepo, openerFromEnv } from '../mfa.repo.js';

const U = '0190a000-0000-7000-8000-0000000000d1', S = '0190a000-0000-7000-8000-0000000000e2', F = '0190a000-0000-7000-8000-0000000000f3', E = '0190a000-0000-7000-8000-0000000000f4',
  R = '0190a000-0000-7000-8000-0000000000a7', A = '0190a000-0000-7000-8000-000000000001';
const ENV = { LIMS_IDENTITY_TOKEN_ENC_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64') }) } as NodeJS.ProcessEnv;
const mkRepo = () => createMfaRepo({ seal: sealerFromEnv(ENV), open: openerFromEnv(ENV) });
const defn = (n: number) => new Proxy({ n }, { get: (t, k) => (typeof k === 'string' ? t.n : undefined), ownKeys: () => ['n'] });   // whatever alias the writer reads comes back as n
function mk(rows: unknown[] = [defn(1)]) {
  const calls: Array<{ sql: string; p: any[] }> = [];
  const tx: any = { query: vi.fn(async (sql: string, p: any[] = []) => { calls.push({ sql, p }); return { rows, rowCount: rows.length }; }) };
  return { tx, calls, repo: mkRepo() as any };
}
const FN = /app\.identity_platform_auth_write_mfa_enrolled_event\s*\(\s*\$1(::uuid)?\s*,\s*\$2(::jsonb)?\s*\)/;
const arg = { id: E, userId: U, platformStaffId: S, detail: { factor_id: F }, requestId: R, clientIp: '203.0.113.9', actorId: A };

describe('repo.recordPlatformMfaEnrolledEvent -> app.identity_platform_auth_write_mfa_enrolled_event (DEFINER only)', () => {
  it('is on the repo (seam present)', () => { expect(typeof (mkRepo() as any).recordPlatformMfaEnrolledEvent).toBe('function'); });
  it('issues exactly ONE statement: the DEFINER with [userId, row json]; never a direct INSERT / table text', async () => {
    const { tx, calls, repo } = mk(); await repo.recordPlatformMfaEnrolledEvent(tx, arg);
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(FN); expect(calls[0]!.sql).not.toMatch(/\bINSERT\b|identity\.platform_events|identity\.platform_staff/i);
    expect(calls[0]!.p).toHaveLength(2); expect(calls[0]!.p[0]).toBe(U); expect(typeof calls[0]!.p[1]).toBe('string');
  });
  it('the row is the PLATFORM_EVENT_SQL columns: fixed event_type and target_type, target = actor = the staff id, nested detail, request id, ip, created_by = the system actor', async () => {
    const { tx, calls, repo } = mk(); await repo.recordPlatformMfaEnrolledEvent(tx, arg); const row = JSON.parse(calls[0]!.p[1]);
    expect(row).toMatchObject({ id: E, event_type: 'platform_mfa_enrolled', target_type: 'platform_staff', target_id: S, actor_platform_staff_id: S, detail: { factor_id: F }, request_id: R, client_ip: '203.0.113.9', created_by: A });
    expect([null, undefined]).toContain(row.target_tenant_id);
    for (const k of ['id', 'event_type', 'target_type', 'target_id', 'detail', 'actor_platform_staff_id', 'request_id', 'client_ip', 'created_by']) expect(row, k).toHaveProperty(k);
  });
  it('the caller cannot choose the event: no eventType / targetType / targetId parameter exists - extra keys in the argument change nothing', async () => {
    const { tx, calls, repo } = mk(); await repo.recordPlatformMfaEnrolledEvent(tx, { ...arg, eventType: 'bootstrap_admin_created', targetType: 'tenant', targetId: A, actorPlatformStaffId: A });
    expect(JSON.parse(calls[0]!.p[1])).toMatchObject({ event_type: 'platform_mfa_enrolled', target_type: 'platform_staff', target_id: S, actor_platform_staff_id: S }); expect(calls[0]!.p[0]).toBe(U);
  });
  it('an empty client ip is sent as null / empty (the DEFINER casts it), never as the string "undefined"', async () => {
    const { tx, calls, repo } = mk(); await repo.recordPlatformMfaEnrolledEvent(tx, { ...arg, clientIp: '' }); const row = JSON.parse(calls[0]!.p[1]);
    expect([null, '']).toContain(row.client_ip); expect(calls[0]!.p[1]).not.toContain('undefined');
  });
  it('the row carries no secret-shaped field: only the listed keys (+ target_tenant_id), nothing from the session or GoTrue', async () => {
    const { tx, calls, repo } = mk(); await repo.recordPlatformMfaEnrolledEvent(tx, arg);
    const allowed = ['id', 'event_type', 'target_type', 'target_id', 'target_tenant_id', 'detail', 'actor_platform_staff_id', 'request_id', 'client_ip', 'created_by', 'created_at', 'updated_at', 'updated_by', 'version'];
    expect(Object.keys(JSON.parse(calls[0]!.p[1])).filter((k) => !allowed.includes(k))).toEqual([]);
  });
  it('a DEFINER result of 0 or no row is a failed write, never a silent success: common.internal', async () => {
    for (const rows of [[defn(0)], []]) {
      const { tx, repo } = mk(rows); const e = await repo.recordPlatformMfaEnrolledEvent(tx, arg).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(LimsError); expect((e as LimsError).code).toBe('common.internal');
    }
  });
  it('a DEFINER error propagates (fail closed): the call rejects with the SAME error, one statement, no fallback to the plain INSERT', async () => {
    const calls: string[] = []; const boom = Object.assign(new Error('identity_platform_auth_write_invalid_input'), { code: 'P0001' });
    const tx: any = { query: vi.fn(async (sql: string) => { calls.push(sql); throw boom; }) };
    await expect(mkRepo().recordPlatformMfaEnrolledEvent(tx, arg)).rejects.toBe(boom); expect(calls).toHaveLength(1); expect(calls[0]).toMatch(FN);
  });
});

describe('recordPlatformEvent is UNCHANGED for its other callers (LD-221 item 4: new method only)', () => {
  it('still ONE plain INSERT INTO identity.platform_events with the nine parameters in the old order', async () => {
    const { tx, calls, repo } = mk([{}]);
    await repo.recordPlatformEvent(tx, { id: E, eventType: 'platform_staff_invited', targetType: 'invitation', targetId: F, actorPlatformStaffId: S, detail: { k: 1 }, requestId: R, clientIp: '203.0.113.9', actorId: A });
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(/INSERT\s+INTO\s+identity\.platform_events/i); expect(calls[0]!.sql).not.toMatch(/identity_platform_auth/);
    expect(calls[0]!.p).toEqual([E, 'platform_staff_invited', 'invitation', F, JSON.stringify({ k: 1 }), S, R, '203.0.113.9', A]);
  });
  it('the SQL text is byte-for-byte the old one (whitespace-normalised)', () => {
    const src = readFileSync(fileURLToPath(new URL('../mfa.repo.ts', import.meta.url)), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain("INSERT INTO identity.platform_events (id, event_type, target_type, target_id, target_tenant_id, detail, actor_platform_staff_id, request_id, client_ip, created_by) VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6, $7, nullif($8, '')::inet, $9)");
  });
});

// ---- static guards (run in the lane; the SQL itself is NOT run there) ----------------------------------------------------------------------------------------
const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');
const MIG_NAME = '20261115157000_identity__add_platform_mfa_event_definer.sql';
const MIGRATION = `${ROOT}db/migrations/${MIG_NAME}`;
const FUNCTION_NAME = 'app.identity_platform_auth_write_mfa_enrolled_event';
const POLICY = 'platform_events__insert__owner_mfa_enrolled';

describe(`migration ${MIG_NAME} (static; NOT executed in the lane)`, () => {
  const sql = () => (existsSync(MIGRATION) ? read(MIGRATION) : '');
  const code = () => sql().replace(/--[^\n]*/g, '');
  const flat = () => code().replace(/\s+/g, ' ');
  it('exists, and sorts after 20261115156000 and before the C0-0B chain 20261115160000', () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(MIG_NAME > '20261115156000_identity__add_platform_mfa_read_definers.sql').toBe(true); expect(MIG_NAME < '20261115160000_engagement__create_engagement_schema.sql').toBe(true);
    expect(readdirSync(`${ROOT}db/migrations`).filter((f) => f.startsWith('20261115157'))).toEqual([MIG_NAME]);
  });
  it('creates exactly ONE function and ONE policy, nothing else (no table, column, trigger, index, view, role, type, alter, drop)', () => {
    const s = code();
    expect([...s.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\S+?)\s*\(/gi)].map((m) => m[2])).toEqual([FUNCTION_NAME]);
    expect([...s.matchAll(/CREATE\s+POLICY\s+(\S+)/gi)].map((m) => m[1])).toEqual([POLICY]);
    expect(s).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TRIGGER|INDEX|VIEW|SCHEMA|ROLE|TYPE|EXTENSION|SEQUENCE)\b/i); expect(s).not.toMatch(/\b(ALTER|DROP)\s+(POLICY|FUNCTION)\b/i);
    expect(s).not.toMatch(/(ENABLE|DISABLE|NO\s+FORCE|FORCE)\s+ROW\s+LEVEL\s+SECURITY/i); expect(s).not.toMatch(/\bBYPASSRLS\b/i); expect(s).not.toMatch(/\bGRANT\b[^;]*\bON\s+(TABLE\s+)?(identity|core)\./i);
  });
  it('function: signature (p_user_id uuid, p_row jsonb) RETURNS integer, plpgsql SECURITY DEFINER, SET search_path = \'\', VOLATILE', () => {
    const s = flat();
    expect(s).toMatch(/app\.identity_platform_auth_write_mfa_enrolled_event\s*\(\s*p_user_id\s+uuid\s*,\s*p_row\s+jsonb\s*\)\s*RETURNS\s+integer/i);
    expect((s.match(/SECURITY\s+DEFINER/gi) ?? []).length).toBe(1); expect((s.match(/SET\s+search_path\s*=\s*''/gi) ?? []).length).toBe(1); expect((s.match(/LANGUAGE\s+plpgsql/gi) ?? []).length).toBe(1);
    expect(s).not.toMatch(/\b(STABLE|IMMUTABLE)\b/i);
  });
  it('owner lims_owner (SET LOCAL ROLE lims_owner as in 20261115156000, or OWNER TO); cites LD-221 in a comment', () => {
    expect(sql()).toMatch(/SET\s+LOCAL\s+ROLE\s+lims_owner|OWNER\s+TO\s+lims_owner/i); expect(sql()).toMatch(/LD-221/);
  });
  it('EXECUTE: REVOKE ALL FROM PUBLIC, GRANT EXECUTE to lims_api only, on (uuid, jsonb)', () => {
    const s = code(); const grants = [...s.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([^;]*?)\s+TO\s+([^;]+);/gi)];
    expect(grants).toHaveLength(1); expect(grants[0]![2]!.trim()).toBe('lims_api'); expect(grants[0]![1]).toMatch(/identity_platform_auth_write_mfa_enrolled_event\s*\(\s*uuid\s*,\s*jsonb\s*\)/i);
    expect(s).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION[^;]*identity_platform_auth_write_mfa_enrolled_event\s*\(\s*uuid\s*,\s*jsonb\s*\)[^;]*FROM\s+PUBLIC/i);
  });
  it('the body writes ONE row into identity.platform_events with exactly the PLATFORM_EVENT_SQL columns and nothing else (no UPDATE / DELETE / TRUNCATE, no other INSERT)', () => {
    const s = flat(); const ins = [...s.matchAll(/INSERT\s+INTO\s+(\S+)\s*\(([^)]*)\)/gi)];
    expect(ins).toHaveLength(1); expect(ins[0]![1]).toBe('identity.platform_events');
    expect(ins[0]![2]!.split(',').map((c) => c.trim()).sort()).toEqual(['actor_platform_staff_id', 'client_ip', 'created_by', 'detail', 'event_type', 'id', 'request_id', 'target_id', 'target_tenant_id', 'target_type'].sort());
    expect(s).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b/i); expect(s).not.toMatch(/\bUPDATE\s+[a-z_."]+\s+SET\b/i);
  });
  it('the body accepts ONLY platform_mfa_enrolled / platform_staff for the staff row of p_user_id, and raises identity_platform_auth_write_invalid_input (P0001) otherwise', () => {
    const s = flat(); expect(s).toContain("'platform_mfa_enrolled'"); expect(s).toContain("'platform_staff'"); expect(s).toMatch(/identity\.platform_staff/); expect(s).toMatch(/p_user_id/);
    expect(s).toMatch(/RAISE\s+EXCEPTION\s+USING\s+ERRCODE\s*=\s*'P0001'\s*,\s*MESSAGE\s*=\s*'identity_platform_auth_write_invalid_input'/i); expect(s).toMatch(/\bIF\b[\s\S]*\bRAISE\b/i);
  });
  it('sets app.pre_user_id from p_user_id (the owner policy needs it) and resets it to the empty string before returning; never sets another GUC value', () => {
    const s = flat(); expect(s).toMatch(/set_config\(\s*'app\.pre_user_id'\s*,\s*coalesce\(\s*p_user_id::text\s*,\s*''\s*\)\s*,\s*true\s*\)/i);
    const resets = [...s.matchAll(/set_config\(\s*'app\.pre_user_id'\s*,\s*''\s*,\s*true\s*\)/gi)]; expect(resets.length).toBeGreaterThanOrEqual(1);
    expect(resets.at(-1)!.index!, 'the reset comes after the INSERT').toBeGreaterThan(s.search(/INSERT\s+INTO/i));
    expect([...s.matchAll(/set_config\(\s*'(app\.[a-z_]+)'/gi)].every((m) => m[1] === 'app.pre_user_id')).toBe(true);
  });
  it(`policy ${POLICY}: FOR INSERT TO lims_owner only; WITH CHECK = the one event type, target = actor = a platform_staff row that belongs to app.pre_user_id; no USING, no literal true`, () => {
    const s = flat(); const m = s.match(/CREATE\s+POLICY\s+(\S+)\s+ON\s+(\S+)\s+FOR\s+(\w+)\s+TO\s+([^\s;]+)\s+WITH\s+CHECK\s*\((.*?)\)\s*;/i);
    expect(m, 'CREATE POLICY ... WITH CHECK (...) ;').not.toBeNull(); const [stmt, name, table, cmd, role, check] = m!;
    expect(name).toBe(POLICY); expect(table).toBe('identity.platform_events'); expect(cmd.toUpperCase()).toBe('INSERT'); expect(role).toBe('lims_owner');
    expect(check).toMatch(/event_type\s*=\s*'platform_mfa_enrolled'/); expect(check).toMatch(/target_type\s*=\s*'platform_staff'/); expect(check).toMatch(/target_id\s*=\s*actor_platform_staff_id/);
    expect(check).toMatch(/identity\.platform_staff/); expect(check).toMatch(/nullif\(\s*current_setting\(\s*'app\.pre_user_id'\s*,\s*true\s*\)\s*,\s*''\s*\)::uuid/i);
    expect(check).not.toMatch(/\bOR\b/i); expect(check.trim()).not.toBe('true'); expect(stmt).not.toMatch(/\bUSING\b/i); expect(stmt).not.toMatch(/\bTO\s+(public|lims_app|lims_api|lims_worker|anon|authenticated)\b/i);
  });
});

describe('db/meta/definer-inventory.yaml row + db/tests/isolation/_registry.sql row for the new function (static; the equality test T0B-08_inventory.test.sql is pgTAP, NOT run in the lane)', () => {
  const yaml = () => read(`${ROOT}db/meta/definer-inventory.yaml`);
  const row = (name: string) => { const m = yaml().match(new RegExp(`"${name.replace('.', '\\.')}"\\s*:\\s*\\{([\\s\\S]*?)\\n  \\}`)); return m ? m[1]! : ''; };
  const list = (r: string, k: string): string[] => { const m = r.match(new RegExp(`"${k}"\\s*:\\s*(\\[[^\\]]*\\])`)); return m ? JSON.parse(m[1]!) : []; };
  const TOUCHES = ['identity.platform_events INSERT', 'identity.platform_staff SELECT'], POLICIES = [POLICY, 'platform_staff__select__owner_only'];
  it('yaml row: owner lims_owner, execute [lims_api] only, a why, touches and policies exactly as fixed above', () => {
    const r = row(FUNCTION_NAME); expect(r).not.toBe('');
    expect(r).toMatch(/"owner"\s*:\s*"lims_owner"/); expect(r).toMatch(/"execute"\s*:\s*\["lims_api"\]/); expect(r).toMatch(/"why"\s*:\s*"[^"]{10,}/); expect(r).toMatch(/LD-221|AUTH-MFA-COMPLETE-1/);
    expect(list(r, 'touches').sort()).toEqual([...TOUCHES].sort()); expect(list(r, 'policies').sort()).toEqual([...POLICIES].sort());
  });
  it('the key appears exactly once; the yaml gained no other function key (the two LD-216 read definers and the rest are untouched)', () => {
    expect(yaml().split(`"${FUNCTION_NAME}"`).length - 1).toBe(1);
    for (const fn of ['app.identity_platform_auth_load_session', 'app.identity_platform_auth_read_mfa_factors', 'app.identity_platform_auth_write_mfa_factor']) expect(yaml().split(`"${fn}"`).length - 1, fn).toBe(1);
  });
  it('_registry.sql carries the same row (touches and policies equal to the yaml row)', () => {
    const reg = read(`${ROOT}db/tests/isolation/_registry.sql`); const line = reg.split('\n').find((l) => l.includes(`('${FUNCTION_NAME}'`)); expect(line).toBeDefined();
    expect(line).toContain("'lims_owner', ARRAY['lims_api']::text[]"); for (const t of TOUCHES) expect(line).toContain(`'${t}'`); for (const p of POLICIES) expect(line).toContain(`'${p}'`);
  });
  it('T0B-06_definers.test.sql counts the new signature (23 identity DEFINERs)', () => {
    const t = read(`${ROOT}db/tests/identity/T0B-06_definers.test.sql`); expect(t).toContain("'identity_platform_auth_write_mfa_enrolled_event(uuid,jsonb)'"); expect(t).toMatch(/count\(\*\) FROM sigs\), 23::bigint/);
  });
});

describe('scope guard: the handler and the repo changed only where LD-221 says', () => {
  const handler = () => read(fileURLToPath(new URL('../../handlers/completeMfaEnrolment.ts', import.meta.url)));
  const repoSrc = () => read(fileURLToPath(new URL('../mfa.repo.ts', import.meta.url)));
  it('completeMfaEnrolment (platform branch) calls ONLY recordPlatformMfaEnrolledEvent: no recordPlatformEvent, no PLATFORM_EVENT_SQL text, no direct INSERT', () => {
    const h = handler(); expect(h).toMatch(/recordPlatformMfaEnrolledEvent/); expect(h).not.toMatch(/\brecordPlatformEvent\b/); expect(h).not.toMatch(/INSERT\s+INTO|platform_events/i);
  });
  it('mfa.repo.ts: the new method names the DEFINER once; the existing DEFINER constants, tenant SQL and recordPlatformEvent are still there', () => {
    const s = repoSrc(); expect(s.split('app.identity_platform_auth_write_mfa_enrolled_event').length - 1).toBe(1);
    for (const k of ['app.identity_session_by_token($1)', 'app.identity_platform_auth_load_session($1::uuid, $2::uuid)', 'app.identity_platform_auth_read_mfa_factors($1::uuid)', 'app.identity_platform_auth_write_session_update($1::uuid, $2::uuid, $3::jsonb)',
      'app.identity_platform_auth_write_mfa_factor($1::uuid, $2::uuid, $3::jsonb)', 'async recordPlatformEvent(']) expect(s).toContain(k);
  });
  it('no contract yaml, web or pipeline file is part of this task: SessionState already requires actor (the yaml is read, never changed)', () => {
    const c = read(`${ROOT}contracts/openapi/identity.yaml`); expect(c).toMatch(/SessionState:[\s\S]*?required:[^\n]*actor/);
  });
});
