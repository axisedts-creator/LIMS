// Contract suite + D-218/D-219 probes against the REAL pinned GoTrue container. Env-gated like core/uploads live tests:
//   LIMS_TEST_GOTRUE_URL          http://127.0.0.1:9999 (internal URL, nothing published in prod; map a port in a local compose)
//   LIMS_TEST_GOTRUE_SERVICE_KEY  service-role JWT of that stack
//   LIMS_TEST_GOTRUE_PSQL         command prefix that runs one SQL string on the GoTrue DB, e.g.
//                                 "docker exec -i supabase-db psql -U supabase_admin -d postgres -At -c"
//   LIMS_TEST_GOTRUE_REUSE_INTERVAL_S  container's GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL (default 10)
// Container must run with: password min length 12, refresh-token rotation on, e-mail autoconfirm off, link TTL per mapping.md.
// Set LIMS_TEST_REQUIRE_LIVE=1 to turn "env missing" into a failure instead of a skip.
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { createHttpGoTrueGateway } from '../gateway.http.js';
import { describeGatewayContract, type Harness } from './contract.suite.js';
import { readVerdicts } from './helpers.js';

const url = process.env['LIMS_TEST_GOTRUE_URL'];
const key = process.env['LIMS_TEST_GOTRUE_SERVICE_KEY'];
const psql = process.env['LIMS_TEST_GOTRUE_PSQL'];
const live = Boolean(url && key && psql);

if (process.env['LIMS_TEST_REQUIRE_LIVE'] === '1') {
  describe('live GoTrue required', () => { it('LIMS_TEST_GOTRUE_URL / _SERVICE_KEY / _PSQL are set', () => { expect(live).toBe(true); }); });
}

const sql = (q: string): string => {
  const [cmd, ...args] = psql!.split(/\s+/);
  return execFileSync(cmd!, [...args, q], { encoding: 'utf8' }).trim();
};
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function liveHarness(): Harness {
  const gateway = createHttpGoTrueGateway({ url: url!, serviceKey: key! });
  const tokenType = { invite: 'confirmation_token', recovery: 'recovery_token' } as const;
  return {
    gateway,
    latestTokenHash: async (email, type) =>
      sql(`select ot.token_hash from auth.one_time_tokens ot join auth.users u on u.id = ot.user_id where lower(u.email) = lower(${lit(email)}) and ot.token_type = '${tokenType[type]}' order by ot.created_at desc limit 1`) || undefined,
    // GoTrue enforces the link TTL from auth.users.{recovery_sent_at,confirmation_sent_at,invited_at}, not one_time_tokens.created_at; age both.
    ageEmailTokens: async (s) => {
      const n = Math.trunc(s);
      sql(`update auth.one_time_tokens set created_at = created_at - interval '${n} seconds'`);
      sql(`update auth.users set recovery_sent_at = recovery_sent_at - interval '${n} seconds', confirmation_sent_at = confirmation_sent_at - interval '${n} seconds', invited_at = invited_at - interval '${n} seconds'`);
    },
    passReuseInterval: async () => { await new Promise((r) => setTimeout(r, (Number(process.env['LIMS_TEST_GOTRUE_REUSE_INTERVAL_S'] ?? 10) + 1) * 1000)); },
    passwordHash: async (id) => sql(`select encrypted_password from auth.users where id = ${lit(id)}`) || undefined,
  };
}

describe.skipIf(!live)('live GoTrue (pinned container)', () => {
  describeGatewayContract('http gateway vs real container', liveHarness, 40_000);

  describe('D-218 probes (raw admin API; verdicts in mapping.md must match reality)', () => {
    it('(a) admin create WITHOUT e-mail: mapping verdict D218_A_CREATE_WITHOUT_EMAIL equals what the container does', async () => {
      const res = await fetch(`${url}/admin/users`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, apikey: key! }, body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      const created = res.ok && typeof body.id === 'string';
      if (created) sql(`delete from auth.users where id = ${lit(body.id!)}`);   // clean up the probe user
      expect(readVerdicts().D218_A_CREATE_WITHOUT_EMAIL).toBe(created ? 'CONFIRMED' : 'REFUTED');
    });
    it('service-role key is required for admin calls (anon/no key → 401/403)', async () => {
      const res = await fetch(`${url}/admin/users?per_page=1`, { headers: { authorization: 'Bearer not-a-valid-token' } });
      expect([401, 403]).toContain(res.status);
    });
    it('gateway never leaks the service key in a thrown error', async () => {
      const g = createHttpGoTrueGateway({ url: url!, serviceKey: key! });
      const err = await g.adminUpdatePassword('0190a000-0000-7000-8000-00000000dead', 'Abcdef-12345').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(JSON.stringify(err) + String((err as Error).message) + String((err as Error).stack)).not.toContain(key!);
    });
  });
});
