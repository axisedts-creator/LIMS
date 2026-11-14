// C6-T33 — API-side metrics (02-TRD §12 table: `lims_reporting_otp_verify_failures_total` gets label `tenant_id` in T33; alert "OTP verify brute force" =
// sum by (tenant_id) (increase(...[1h])) > 50, REQ-SEC-133). Same harness as portal.service.test.ts.
// ASSUMED: verifyPortalOtp (P2) calls ctx.metrics.inc('lims_reporting_otp_verify_failures_total', { tenant_id }) once per wrong code (also the attempt that exhausts the challenge);
// the label set is EXACTLY { tenant_id } (a challenge / link id label would be unbounded cardinality and identify a person's link); a right code increments nothing.
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { TENANT_A, makePortalWorld, rejection, sha256buf, type PortalWorld } from './portal.helpers.js';

const FAIL = 'lims_reporting_otp_verify_failures_total';
type M = { name: string; labels?: Record<string, unknown>; by?: number };

async function verify(w: PortalWorld, cred: string, challengeId: string, code: string, metrics: M[]) {
  const ctx = await w.portalCtx(cred);
  ctx.metrics = { inc: (name: string, labels?: Record<string, unknown>, by?: number) => { metrics.push({ name, labels, by }); }, set() {}, observe() {} };
  return w.run('verifyPortalOtp', ctx, { params: { challenge_id: challengeId }, body: { code } });
}
function challenge(w: PortalWorld, link: any) {
  const id = w.db.newId(); const code = '482913';
  w.db.insert('otp_challenges', { id, tenant_id: link['tenant_id'], link_id: link['id'], channel: 'sms', destination_sha256: sha256buf('dest'), code_hmac: w.hmacOf(id, code), status: 'pending',
    expires_at: new Date(Date.parse(w.now()) + 600_000).toISOString(), created_by: link['id'] });
  return { id, code };
}

describe('lims_reporting_otp_verify_failures_total{tenant_id}', () => {
  it('each wrong code increments once, label set is exactly { tenant_id: <ctx tenant> }', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = challenge(w, l.row); const m: M[] = [];
    for (let i = 0; i < 3; i++) await rejection(verify(w, l.cred, ch.id, '000000', m));
    const f = m.filter((x) => x.name === FAIL); expect(f).toHaveLength(3);
    for (const x of f) { expect(x.labels).toEqual({ tenant_id: TENANT_A }); expect(x.by ?? 1).toBe(1); }
  });
  it('the attempt that exhausts the challenge is counted too (5 wrong codes -> 5 increments)', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = challenge(w, l.row); const m: M[] = [];
    for (let i = 0; i < 5; i++) await rejection(verify(w, l.cred, ch.id, '000000', m));
    expect(m.filter((x) => x.name === FAIL)).toHaveLength(5);
  });
  it('a right code increments nothing; no metric label carries the code, challenge id or link id', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = challenge(w, l.row); const m: M[] = [];
    await rejection(verify(w, l.cred, ch.id, '000000', m));
    const ok = await verify(w, l.cred, ch.id, ch.code, m); expect(ok.status).toBe(200);
    expect(m.filter((x) => x.name === FAIL)).toHaveLength(1);
    expect(JSON.stringify(m)).not.toContain(ch.code); expect(JSON.stringify(m)).not.toContain(ch.id); expect(JSON.stringify(m)).not.toContain(String(l.row['id']));
  });
  it('without ctx.metrics (older callers) a wrong code still fails with auth.otp_invalid (metrics are optional)', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = challenge(w, l.row);
    const err = await rejection(w.call.p2(l.cred, ch.id, '000000')); expect(err.code).toBe('auth.otp_invalid');
  });
});
