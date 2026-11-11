// C6-T20 portalSession AuthResolver (CR-C6-001) + DEFINER usage (CR-C6-002). 02-TRD §6.6, 01-PRD AC-11.5, 07-SECURITY REQ-SEC-019..021/095, abuse A5/A20.
// ASSUMED: modules/reporting/index.ts manifest.authResolvers.portalSession = { resolve(credential, tx) } (core/auth/resolvers.ts shape):
//   credential `link.<token>` | `session.<token>`; token hashed with domain/tokens.hashToken (sha256, 32 bytes); ONE statement to the DEFINER
//   `SELECT * FROM app.reporting_resolve_portal_credential($1, $2)` ($1 'link'|'session', $2 bytea); ok result =
//   { actor: { type: 'portal', id: link_id }, tenantId, extraClaims: { portal_stage, portal_report_id, portal_session_id? } }; failure = { error: 'reporting.link_invalid' }.
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });   // first import of the module manifest parses the OpenAPI spec
import { errShape, makePortalWorld, rejection, REPORT_A, TENANT_A, sha256hex } from './portal.helpers.js';

const BAD = (w: ReturnType<typeof makePortalWorld>) => {
  const l = w.mkLink(); const revoked = w.mkLink({ revoked_at: w.now() }); const s = w.mkSession(l.row); const ended = w.mkSession(l.row, { ended_at: w.now() });
  const idle = w.mkSession(l.row, { idle_expires_at: new Date(Date.parse(w.now()) - 1000).toISOString() });
  const abs = w.mkSession(l.row, { absolute_expires_at: new Date(Date.parse(w.now()) - 1000).toISOString() });
  const rl = w.mkLink(); const rs = w.mkSession(rl.row); rl.row['revoked_at'] = w.now();      // session of a link revoked after the session started
  return {
    'unknown link': 'link.AAAAAAAAAAAAAAAAAAAAAA', 'revoked link': revoked.cred, 'unknown session': 'session.' + 'A'.repeat(43), 'ended session': ended.cred,
    'idle-expired session': idle.cred, 'absolute-expired session': abs.cred, 'session of revoked link': rs.cred,
    'link token used as session': 'session.' + l.token, 'session token used as link': 'link.' + s.token,
    'no prefix': l.token, 'unknown prefix': 'bearer.' + l.token, 'empty token': 'link.', 'prefix only dots': 'link..', 'whitespace': 'link. ' + l.token,
    'too short': 'link.abc', 'too long': 'link.' + 'A'.repeat(5000), 'non base64url': 'link.' + '*'.repeat(22), 'sql-ish': "link.' OR 1=1 --", 'null byte': 'link.' + l.token + '\u0000',
  } as Record<string, string>;
};

describe('portalSession resolver: valid credentials', () => {
  it('link -> claims { sub = link id, tenant, actor portal, portal_stage link, portal_report_id }', async () => {
    const w = makePortalWorld(); const l = w.mkLink();
    const c = await w.authenticate(l.cred);
    expect(c).toMatchObject({ sub: l.row['id'], tenant_id: TENANT_A, actor_type: 'portal', portal_stage: 'link', portal_report_id: REPORT_A });
    expect(c['portal_session_id']).toBeUndefined();
  });
  it('expired (unrevoked) link -> portal_stage expired_link, not an error (P5 needs it)', async () => {
    const w = makePortalWorld(); const l = w.mkLink({ expires_at: new Date(Date.parse(w.now()) + 1000).toISOString() }); w.advance(2000);
    expect(await w.authenticate(l.cred)).toMatchObject({ portal_stage: 'expired_link', sub: l.row['id'] });
  });
  it('session -> portal_stage session + portal_session_id', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row);
    expect(await w.authenticate(s.cred)).toMatchObject({ sub: l.row['id'], actor_type: 'portal', portal_stage: 'session', portal_session_id: s.row['id'], portal_report_id: REPORT_A });
  });
  // C6-T43: REVISED. The T20 version asserted that the resolver must NOT return portal_link_purpose (core allow-list had no such key). 02-TRD §6.6 and 08 A21.1 say the opposite:
  // claims carry portal_link_purpose (report|dues) because the RLS policies on report_versions / qr_tokens read it (migration 20261105001900:914/937). Pinned in portal.dues.test.ts.
  it('claims carry portal_link_purpose from the link / session row (08 A21.1)', async () => {
    const w = makePortalWorld(); const l = w.mkLink({ purpose: 'dues' }); const s = w.mkSession(l.row);
    await expect(w.authenticate(s.cred)).resolves.toMatchObject({ portal_stage: 'session', portal_link_purpose: 'dues' });
  });
});

describe('portalSession resolver: AC-11.5 identical invalid answers (REQ-SEC-095)', () => {
  it('every invalid credential rejects reporting.link_invalid with a byte-identical error', async () => {
    const w = makePortalWorld(); const cases = BAD(w); const shapes = new Set<string>();
    for (const [name, cred] of Object.entries(cases)) {
      const e = await rejection(w.authenticate(cred));
      expect(e.code, name).toBe('reporting.link_invalid');
      shapes.add(errShape(e));
    }
    expect(shapes.size).toBe(1);
  });
  it('the error never carries the credential, token hash or link id', async () => {
    const w = makePortalWorld(); const l = w.mkLink({ revoked_at: w.now() });
    const e = await rejection(w.authenticate(l.cred)); const s = JSON.stringify(e) + String(e.message) + String(e.stack ?? '').split('\n')[0];
    expect(s).not.toContain(l.token); expect(s).not.toContain(sha256hex(l.token)); expect(s).not.toContain(l.row['id']);
  });
  it('a resolver outage is not reported as link_invalid (fail closed, never an oracle for "valid")', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const tx = w.db.newTx(); tx.query = async () => { throw new Error('db down'); };
    const reg = await (await import('../../../core/auth/resolvers.js')).createAuthResolverRegistry([{ name: 'reporting', authResolvers: (await import('../index.js')).manifest.authResolvers! }]);
    const e = await rejection(reg.authenticate('portalSession', l.cred, tx));
    expect(e.code ?? 'thrown').not.toBe('reporting.link_invalid');
  });
});

describe('portalSession resolver: DEFINER usage (CR-C6-002, REQ-SEC-019..021)', () => {
  it('hashes the token part (not the prefix) and passes (kind, 32-byte bytea) to app.reporting_resolve_portal_credential only', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row);
    w.db.stmts.length = 0; await w.authenticate(l.cred); await w.authenticate(s.cred);
    const calls = w.db.stmts.filter((x) => /reporting_resolve_portal_credential/i.test(x.text));
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.values[0])).toEqual(['link', 'session']);
    for (const [i, tok] of [l.token, s.token].entries()) {
      const h = calls[i]!.values[1] as Uint8Array;
      expect(h.length).toBe(32); expect(Buffer.from(h).toString('hex')).toBe(sha256hex(tok));
    }
  });
  it('no plaintext token or prefix-qualified credential reaches SQL text, values or logs', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row);
    await w.authenticate(l.cred); await w.authenticate(s.cred); await rejection(w.authenticate('link.' + 'B'.repeat(22)));
    const all = w.allText(); for (const t of [l.token, s.token, l.cred, s.cred]) expect(all).not.toContain(t);
  });
  it('resolution never writes and reads no reporting table except the revoked-link re-check of a session (RLS: lims_app has no pre-auth policy)', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); w.db.stmts.length = 0;
    await w.authenticate(l.cred); await rejection(w.authenticate('link.' + 'C'.repeat(22)));
    expect(w.db.stmts.filter((x) => /\breporting\.\w+/i.test(x.text.replace(/app\.reporting_resolve_portal_credential/gi, '')))).toEqual([]);   // link stage: DEFINER only
    await w.authenticate(s.cred);
    for (const x of w.db.stmts) for (const t of x.text.replace(/app\.reporting_resolve_portal_credential/gi, '').matchAll(/\breporting\.(\w+)/gi)) expect(t[1]).toBe('portal_links');
    expect(w.db.writes()).toEqual([]);
  });
  it('malformed credentials are rejected without a DB round trip or with the DEFINER only (no SQL built from input)', async () => {
    const w = makePortalWorld(); w.db.stmts.length = 0;
    for (const c of ["link.' OR 1=1 --", 'session.;DROP TABLE x', 'link.' + 'A'.repeat(5000)]) await rejection(w.authenticate(c));
    for (const s of w.db.stmts) { expect(s.text).toMatch(/^\s*SELECT \* FROM app\.reporting_resolve_portal_credential\(\$1, \$2\)\s*$/i); }
  });
});
