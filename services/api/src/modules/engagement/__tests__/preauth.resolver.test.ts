// C16.T-A2 — patientPreAuth AuthResolver (CR-C16-005; 02-TRD §4.2, §6.3; 05-SCHEMA §6.2 app.core_resolve_tenant_code, §6.3 app.engagement_resolve_preauth; 01-PRD US-EN-01.1/.3; 07-SECURITY REQ-SEC-017).
// done_when (resolver part): pre-auth claims carry tenant + stage only. Fails now: manifest.authResolvers.patientPreAuth is the T-01 placeholder that resolves nothing (every credential -> 401, so the valid cases fail).
//
// SEAMS (spec does not fix them):
//   Resolver = manifest.authResolvers.patientPreAuth ({ resolve(credential, tx) }) exercised through core createAuthResolverRegistry (the real path), key 'patientPreAuth' (security scheme X-Lims-Patient-PreAuth).
//   Credential 1 `t.<tenant_code>` (tenant_code ^[a-z][a-z0-9_]{2,31}$): ONE statement `SELECT * FROM app.core_resolve_tenant_code($1)` with the code text; accepted only when status = 'active';
//     claims { sub = fresh uuidv7 per call, tenant_id, actor_type 'patient', patient_stage 'pre_auth' } - NO otp_token_sha256.
//   Credential 2 `c.<tenant_code>.<challenge_token>` (token = 43-char base64url, split on '.'): ONE statement `SELECT * FROM app.engagement_resolve_preauth($1, $2)`, $1 = tenant code text, $2 = sha256Bytes(<token string>)
//     as a 32-byte bytea (08 R24); claims { sub = challenge_id, tenant_id (from the DEFINER row ONLY), actor_type 'patient', patient_stage 'pre_auth', otp_token_sha256 = lowercase hex of the hash }.
//   Every failure (unknown, suspended, malformed, wrong tenant for the token, expired + 24 h) -> undefined -> core throws auth.unauthenticated (identical error); junk never costs a DB round trip.
//   The DEFINERs are emulated by an in-memory table (they return no row where the SQL does); their real behaviour is db/tests/engagement/T-A2_resolve_preauth.test.sql.
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 }); // first import of the module manifest parses the OpenAPI spec
import { randomToken, sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { createAuthResolverRegistry } from '../../../core/auth/resolvers.js';
import { manifest } from '../index.js';

const A: string = TENANTS.A;
const B: string = TENANTS.B;
const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW = Date.parse('2026-03-01T04:00:00.000Z');

interface Tenant { id: string; code: string; status: 'active' | 'suspended' }
interface Chal { id: string; tenant_id: string; token: string; expires_at: number }
function world(tenants: Tenant[], chals: Chal[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (/^\s*select\s+\*\s+from\s+app\.core_resolve_tenant_code\s*\(\s*\$1\s*\)\s*;?\s*$/i.test(text) && values.length === 1) {
        const t = tenants.find((x) => x.code === values[0]); return t ? { rows: [{ tenant_id: t.id, status: t.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/^\s*select\s+\*\s+from\s+app\.engagement_resolve_preauth\s*\(\s*\$1\s*,\s*\$2\s*\)\s*;?\s*$/i.test(text) && values.length === 2) {
        const [code, h] = values; if (typeof code !== 'string' || !(h instanceof Uint8Array) || h.length !== 32) return { rows: [], rowCount: 0 };   // as the DEFINER: NULL / wrong length -> no row
        const c = chals.find((x) => hex(sha256Bytes(x.token)) === hex(h) && x.expires_at > NOW - 24 * 3_600_000);
        const t = c && tenants.find((x) => x.id === c.tenant_id && x.code === code && x.status === 'active');
        return c && t ? { rows: [{ tenant_id: c.tenant_id, challenge_id: c.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error(`resolver issued something other than a DEFINER lookup: ${text}`);
    },
  };
  const registry = createAuthResolverRegistry([manifest]);
  return { calls, tx, authenticate: (cred: string) => registry.authenticate('patientPreAuth', cred, tx) };
}
const TENANTS_ = (): Tenant[] => [{ id: A, code: 'syn_alpha', status: 'active' }, { id: B, code: 'syn_beta', status: 'active' }, { id: ID(0x5a), code: 'syn_gamma', status: 'suspended' }];
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };

describe('patientPreAuth resolver: t.<tenant_code> (routing selector only)', () => {
  it('is registered under the key patientPreAuth and exposes resolve()', () => {
    expect(createAuthResolverRegistry([manifest]).has('patientPreAuth')).toBe(true);
    expect(typeof (manifest.authResolvers as any).patientPreAuth.resolve).toBe('function');
  });
  it('active tenant -> claims { sub (uuidv7), tenant_id, actor_type patient, patient_stage pre_auth } and nothing else (no membership, no otp_token_sha256)', async () => {
    const w = world(TENANTS_(), []); const c: any = await w.authenticate('t.syn_alpha');
    expect(c).toMatchObject({ tenant_id: A, actor_type: 'patient', patient_stage: 'pre_auth' });
    expect(c.sub).toMatch(UUIDV7);
    expect(Object.keys(c).sort()).toEqual(['actor_type', 'patient_stage', 'sub', 'tenant_id']);
    expect(w.calls).toHaveLength(1); expect(w.calls[0]!.text).toMatch(/app\.core_resolve_tenant_code/); expect(w.calls[0]!.values).toEqual(['syn_alpha']);
  });
  it('a fresh actor id per call (nothing links two anonymous callers)', async () => {
    const w = world(TENANTS_(), []); const a: any = await w.authenticate('t.syn_alpha'); const b: any = await w.authenticate('t.syn_alpha');
    expect(a.sub).not.toBe(b.sub);
  });
  it('the tenant comes from the DEFINER row, per code: syn_beta -> tenant B', async () => {
    const w = world(TENANTS_(), []); expect(await w.authenticate('t.syn_beta')).toMatchObject({ tenant_id: B });
  });
  it('suspended tenant, unknown code and every malformed code -> the same auth.unauthenticated 401; junk never reaches the DB', async () => {
    const w = world(TENANTS_(), []);
    const junk = ['t.', 't', 't.SYN_ALPHA', 't.1abc', 't.ab', `t.${'a'.repeat(33)}`, 't.syn-alpha', 't.syn alpha', 't.syn_alpha.', 't.syn_alpha\n', 't. syn_alpha', "t.x'; DROP TABLE core.tenants;--", 'T.syn_alpha', 'x.syn_alpha', '', '.', 't..', 't.syn_alpha.extra', 't.\u0000abc'];
    const shapes = new Set<string>(); const bad = ['t.syn_gamma', 't.syn_zzz', ...junk];
    for (const cred of bad) { const e = await rejection(w.authenticate(cred)); expect(e.code, cred).toBe('auth.unauthenticated'); expect(e.statusCode, cred).toBe(401); shapes.add(JSON.stringify({ c: e.code, s: e.statusCode, m: e.message, n: e.name })); if (cred.length > 6) expect(JSON.stringify(e) + String(e.message), cred).not.toContain(cred); }
    expect(shapes.size).toBe(1);
    expect(w.calls.length).toBe(2);                                                                                      // only the two well-formed codes reached the DEFINER
  });
});

describe('patientPreAuth resolver: c.<tenant_code>.<challenge_token> (verifyPatientOtp)', () => {
  const chal = (n: number, over: Partial<Chal> = {}): Chal => ({ id: ID(0xc00 + n), tenant_id: A, token: randomToken(32), expires_at: NOW + 300_000, ...over });
  it('live challenge -> claims { sub = challenge_id, tenant_id, actor_type patient, patient_stage pre_auth, otp_token_sha256 = hex(sha256(token)) } and nothing else', async () => {
    const ch = chal(1); const w = world(TENANTS_(), [ch]); const c: any = await w.authenticate(`c.syn_alpha.${ch.token}`);
    expect(c).toEqual({ sub: ch.id, tenant_id: A, actor_type: 'patient', patient_stage: 'pre_auth', otp_token_sha256: hex(sha256Bytes(ch.token)) });
    expect(c.otp_token_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('one DEFINER call with ($code text, sha256 as a 32-byte bytea); the plaintext token never reaches SQL or an error', async () => {
    const ch = chal(2); const w = world(TENANTS_(), [ch, chal(3)]); await w.authenticate(`c.syn_alpha.${ch.token}`);
    expect(w.calls).toHaveLength(1); expect(w.calls[0]!.text).toMatch(/app\.engagement_resolve_preauth/);
    const [code, h] = w.calls[0]!.values as [string, Uint8Array]; expect(code).toBe('syn_alpha'); expect(h).toBeInstanceOf(Uint8Array); expect(h.length).toBe(32); expect(hex(h)).toBe(hex(sha256Bytes(ch.token)));
    expect(JSON.stringify(w.calls)).not.toContain(ch.token);
  });
  it('the tenant is the challenge\'s own: the right token under ANOTHER tenant\'s code -> 401 (no cross-tenant probing, 07-SECURITY)', async () => {
    const ch = chal(4, { tenant_id: B }); const w = world(TENANTS_(), [ch]);
    expect(await w.authenticate(`c.syn_beta.${ch.token}`)).toMatchObject({ tenant_id: B, sub: ch.id });
    expect((await rejection(w.authenticate(`c.syn_alpha.${ch.token}`))).code).toBe('auth.unauthenticated');
  });
  it('unknown token, expired + 24 h, suspended tenant and every malformed credential -> the same 401; malformed ones never reach the DB; errors never echo the credential', async () => {
    const live = chal(5); const old = chal(6, { expires_at: NOW - 25 * 3_600_000 }); const susp = chal(7, { tenant_id: ID(0x5a) });
    const w = world(TENANTS_(), [live, old, susp]); const t = live.token;
    const wellFormedMiss: Record<string, string> = { 'unknown token': `c.syn_alpha.${randomToken(32)}`, 'expired + 24 h': `c.syn_alpha.${old.token}`, 'suspended tenant': `c.syn_gamma.${susp.token}`, 'unknown tenant code': `c.syn_zzz.${t}` };
    const malformed: Record<string, string> = {
      'two parts': `c.${t}`, 'four parts': `c.syn_alpha.${t}.x`, 'empty token': 'c.syn_alpha.', 'empty code': `c..${t}`, 'short token (42)': `c.syn_alpha.${t.slice(0, 42)}`, 'long token (44)': `c.syn_alpha.${t}A`,
      'non base64url char': `c.syn_alpha.${t.slice(0, 42)}*`, 'base64 padding': `c.syn_alpha.${t.slice(0, 42)}=`, 'dot inside token': `c.syn_alpha.${t.slice(0, 20)}.${t.slice(21)}`, 'uppercase code': `c.SYN_ALPHA.${t}`,
      'bad prefix C': `C.syn_alpha.${t}`, 'bad prefix x': `x.syn_alpha.${t}`, 'trailing newline': `c.syn_alpha.${t}\n`, 'leading space': ` c.syn_alpha.${t}`, 'null byte': `c.syn_alpha.${t.slice(0, 42)}\u0000`,
      'hex of the hash': `c.syn_alpha.${hex(sha256Bytes(t))}`, 'way too long': `c.syn_alpha.${'A'.repeat(5000)}`, 'sql-ish': "c.syn_alpha.' OR 1=1 --", 'wrong scheme (a bearer JWT)': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig',
    };
    const shapes = new Set<string>();
    for (const [n, cred] of [...Object.entries(wellFormedMiss), ...Object.entries(malformed)]) {
      const e = await rejection(w.authenticate(cred)); expect(e.code, n).toBe('auth.unauthenticated'); expect(e.statusCode, n).toBe(401);
      shapes.add(JSON.stringify({ c: e.code, s: e.statusCode, m: e.message, nm: e.name })); if (cred.length > 12) expect(JSON.stringify(e) + String(e.message) + String(e.stack ?? '').split('\n')[0], n).not.toContain(cred);
    }
    expect(shapes.size).toBe(1);
    expect(w.calls.length).toBe(Object.keys(wellFormedMiss).length);                                                     // junk costs no round trip
  });
  it('issues SELECTs of the two DEFINERs only: never a write, never a table read (no tenant yet, 02-TRD §4.2)', async () => {
    const ch = chal(8); const w = world(TENANTS_(), [ch]);
    await w.authenticate(`c.syn_alpha.${ch.token}`); await w.authenticate('t.syn_alpha'); await rejection(w.authenticate(`c.syn_alpha.${randomToken(32)}`));
    for (const c of w.calls) expect(c.text).toMatch(/^\s*select\s+\*\s+from\s+app\.(core_resolve_tenant_code|engagement_resolve_preauth)\s*\(/i);
  });
});
