// C16.T-Q3 — queueDisplayToken AuthResolver (CR-C16-005; 02-TRD §4.10, §6.3; 05-SCHEMA §6.3 app.engagement_resolve_display; 01-PRD US-EN-22.3/22.4; 07-SECURITY REQ-SEC-017 device).
// done_when: "device actor limited to Q9"; tests: "revoked -> 401".
// Fails now: manifest.authResolvers.queueDisplayToken is the T-01 placeholder that resolves nothing (every credential -> 401, so the valid-token cases fail).
//
// SEAMS (spec does not fix them):
//   Resolver = manifest.authResolvers.queueDisplayToken ({ resolve(credential, tx) }), exercised through core createAuthResolverRegistry (the real path), key 'queueDisplayToken'.
//   Credential = the 43-char base64url token (openapi pairQueueDisplay display_token pattern ^[A-Za-z0-9_-]{43}$), hashed as sha256Bytes(<token string>) (packages/shared-ts crypto; same as
//   reporting hashToken, 08 R24) and passed as ONE bytea parameter to `SELECT * FROM app.engagement_resolve_display($1)`; nothing else is queried or written (no tenant yet).
//   Ok result = { tenantId, actor:{type:'device', id: display_id}, centreId, extraClaims:{ device_kind:'queue_display' } } -> DbClaims { sub, tenant_id, actor_type:'device', centre_id, device_kind }.
//   Every failure (unknown, revoked, suspended tenant, malformed) -> undefined -> core throws auth.unauthenticated (TRD §4.10 "resolver returns undefined -> 401").
//   The DEFINER is emulated here by an in-memory table (revoked / suspended-tenant rows return no row, as the SQL does); its real behaviour is db/tests/engagement/T-Q3_resolve_display.test.sql.
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 }); // first import of the module manifest parses the OpenAPI spec
import { randomToken, sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { createAuthResolverRegistry } from '../../../core/auth/resolvers.js';
import { manifest } from '../index.js';

const A: string = TENANTS.A;
const B: string = TENANTS.B;
const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
const C1 = ID(0xc1), CB = ID(0xcb);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

interface Disp { tenant_id: string; centre_id: string; display_id: string; token: string; status: 'active' | 'revoked'; tenantActive?: boolean }
function world(rows: Disp[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (!/^\s*select\s+\*\s+from\s+app\.engagement_resolve_display\s*\(\s*\$1\s*\)\s*;?\s*$/i.test(text) || values.length !== 1) throw new Error(`resolver issued something other than the DEFINER lookup: ${text}`);
      const v = values[0];
      if (!(v instanceof Uint8Array) || v.length !== 32) return { rows: [], rowCount: 0 }; // the DEFINER returns nothing for NULL / wrong length
      const r = rows.find((d) => hex(sha256Bytes(d.token)) === hex(v) && d.status === 'active' && d.tenantActive !== false);
      return r ? { rows: [{ tenant_id: r.tenant_id, centre_id: r.centre_id, display_id: r.display_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
  };
  const registry = createAuthResolverRegistry([manifest]);
  return { calls, tx, authenticate: (cred: string) => registry.authenticate('queueDisplayToken', cred, tx) };
}
const mk = (n: number, over: Partial<Disp> = {}): Disp => ({ tenant_id: A, centre_id: C1, display_id: ID(0xd00 + n), token: randomToken(32), status: 'active', ...over });
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };

describe('queueDisplayToken resolver: valid token', () => {
  it('is registered under the key queueDisplayToken and the registry accepts it (CR-C16-005)', () => {
    expect(createAuthResolverRegistry([manifest]).has('queueDisplayToken')).toBe(true);
    expect(typeof (manifest.authResolvers as any).queueDisplayToken.resolve).toBe('function');
  });
  it('active display -> claims { sub = display id, tenant_id, actor_type device, centre_id, device_kind queue_display } and nothing else', async () => {
    const d = mk(1); const w = world([d]);
    const c = await w.authenticate(d.token);
    expect(c).toEqual({ sub: d.display_id, tenant_id: A, actor_type: 'device', centre_id: C1, device_kind: 'queue_display' });
  });
  it('queries only the DEFINER, once, with the 32-byte SHA-256 of the token as bytea - never the plaintext token', async () => {
    const d = mk(2); const w = world([d, mk(3)]);
    await w.authenticate(d.token);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.text).toMatch(/app\.engagement_resolve_display/);
    const arg = w.calls[0]!.values[0] as Uint8Array;
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(arg.length).toBe(32);
    expect(hex(arg)).toBe(hex(sha256Bytes(d.token)));
    expect(JSON.stringify(w.calls)).not.toContain(d.token);
  });
  it('the token of a tenant-B display yields tenant-B claims, never tenant A (tenant comes from the DEFINER row only)', async () => {
    const a = mk(4), b = mk(5, { tenant_id: B, centre_id: CB });
    const w = world([a, b]);
    expect(await w.authenticate(b.token)).toMatchObject({ sub: b.display_id, tenant_id: B, centre_id: CB, actor_type: 'device' });
    expect(await w.authenticate(a.token)).toMatchObject({ sub: a.display_id, tenant_id: A, centre_id: C1 });
  });
});

describe('queueDisplayToken resolver: every invalid credential is the same 401 (US-EN-22.4, 07 AB-8)', () => {
  const live = mk(10);
  const bad = (): Record<string, string> => {
    const revoked = mk(11, { status: 'revoked' });
    const suspended = mk(12, { tenantActive: false });
    return {
      'unknown token': randomToken(32), 'revoked display': revoked.token, 'display of a suspended tenant': suspended.token,
      empty: '', 'too short (42)': live.token.slice(0, 42), 'too long (44)': live.token + 'A', 'non base64url char': live.token.slice(0, 42) + '*', 'trailing newline': live.token + '\n',
      'leading space': ' ' + live.token.slice(0, 42), 'null byte': live.token.slice(0, 42) + '\u0000', 'sql-ish': "' OR 1=1 --", 'device token of another credential kind': 'lmsd_' + live.token.slice(0, 43),
      'way too long': 'A'.repeat(5000), 'hex of the hash': hex(sha256Bytes(live.token)), 'base64 padding': live.token.slice(0, 42) + '=',
    };
  };
  it('rejects with auth.unauthenticated and an identical error shape; the credential never appears in the error', async () => {
    const cases = bad();
    const w = world([live, mk(11, { status: 'revoked', token: cases['revoked display']! }), mk(12, { tenantActive: false, token: cases['display of a suspended tenant']! })]);
    const shapes = new Set<string>();
    for (const [name, cred] of Object.entries(cases)) {
      const e = await rejection(w.authenticate(cred));
      expect(e.code, name).toBe('auth.unauthenticated');
      expect(e.statusCode, name).toBe(401);
      shapes.add(JSON.stringify({ code: e.code, status: e.statusCode, message: e.message, name: e.name }));
      if (cred.length > 8) expect(JSON.stringify(e) + String(e.message) + String(e.stack ?? '').split('\n')[0], name).not.toContain(cred);
    }
    expect(shapes.size).toBe(1);
  });
  it('revoking the display flips the very same token from claims to 401 (US-EN-22.4)', async () => {
    const d = mk(13); const w = world([d]);
    await expect(w.authenticate(d.token)).resolves.toMatchObject({ sub: d.display_id });
    d.status = 'revoked';
    expect((await rejection(w.authenticate(d.token))).code).toBe('auth.unauthenticated');
  });
  it('never writes and never issues a second statement while rejecting (no tenant yet, 02-TRD §6.3)', async () => {
    const w = world([live]);
    for (const cred of Object.values(bad())) await rejection(w.authenticate(cred));
    for (const c of w.calls) expect(c.text).toMatch(/^\s*select\s+\*\s+from\s+app\.engagement_resolve_display/i);
  });
});
