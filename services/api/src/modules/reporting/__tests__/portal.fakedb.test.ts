// C6-T20: self-check of the portal.helpers.ts fake (so a failing T20 test is never the fake's fault). Passes today; needs no implementation.
import { describe, expect, it } from 'vitest';
import { makePortalWorld, REPORT_A, TENANT_A, sha256buf } from './portal.helpers.js';

describe('portal fake db', () => {
  it('bytea / time comparisons, IS NULL, IN, ORDER BY DESC LIMIT, count(*)', async () => {
    const w = makePortalWorld(); const { row } = w.mkLink(); const tx = w.db.newTx();
    const hit = (await tx.query('SELECT id FROM reporting.portal_links WHERE token_sha256 = $1 AND revoked_at IS NULL AND expires_at > now()', [new Uint8Array(row['token_sha256'])])).rows;
    expect(hit.map((r: any) => r.id)).toEqual([row['id']]);
    w.advance(31 * 86400_000);
    expect((await tx.query('SELECT id FROM reporting.portal_links WHERE expires_at > now() AND tenant_id = $1', [TENANT_A])).rows).toEqual([]);
    expect((await tx.query(`SELECT version_no FROM reporting.report_versions WHERE report_id = $1 AND status IN ('released','superseded') ORDER BY version_no DESC LIMIT 1`, [REPORT_A])).rows).toEqual([{ ...(await tx.query('SELECT version_no FROM reporting.report_versions WHERE report_id = $1', [REPORT_A])).rows[0] }]);
    expect((await tx.query('SELECT count(*)::int AS n FROM reporting.report_versions WHERE report_id = $1', [REPORT_A])).rows[0].n).toBe(1);
  });
  it('DEFINER emulation: link / expired_link / session / revoked / bad length', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); const tx = w.db.newTx();
    const q = (k: string, h: Buffer) => tx.query('SELECT * FROM app.reporting_resolve_portal_credential($1, $2)', [k, h]).then((r: any) => r.rows);
    expect((await q('link', l.row['token_sha256']))[0].stage).toBe('link');
    expect((await q('session', s.row['token_sha256']))[0]).toMatchObject({ stage: 'session', session_id: s.row['id'] });
    expect(await q('session', l.row['token_sha256'])).toEqual([]); expect(await q('link', sha256buf('nope').subarray(0, 31))).toEqual([]);
    w.advance(16 * 60_000); expect(await q('session', s.row['token_sha256'])).toEqual([]);
    w.advance(31 * 86400_000); expect((await q('link', l.row['token_sha256']))[0].stage).toBe('expired_link');
    l.row['revoked_at'] = w.now(); expect(await q('link', l.row['token_sha256'])).toEqual([]);
  });
  it('rollback undoes writes and jobs; commit keeps them; a second UPDATE waits for the first tx (READ COMMITTED)', async () => {
    const w = makePortalWorld(); const { row } = w.mkLink(); const t1 = w.db.newTx(); const t2 = w.db.newTx();
    await t1.query(`UPDATE reporting.portal_links SET use_count = use_count + 1 WHERE tenant_id = $1 AND id = $2`, [TENANT_A, row['id']]);
    await t1.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['x.y', '{}', 'k']);
    let second = false; const p = t2.query(`UPDATE reporting.portal_links SET use_count = 99 WHERE tenant_id = $1 AND id = $2 RETURNING id`, [TENANT_A, row['id']]).then((r: any) => { second = true; return r.rows; });
    await new Promise((r) => setTimeout(r, 5)); expect(second).toBe(false);
    w.db.endTx(t1, true); expect(await p).toHaveLength(1); expect(row['use_count']).toBe(99); expect(w.db.jobs).toHaveLength(0);
    w.db.endTx(t2, false);
  });
  it('limiter grammar is strict (otp_request accepts p: only; report_download l: 20/h; otp_verify o: 5)', async () => {
    const w = makePortalWorld(); const rl = w.baseCtx().rateLimit;
    await expect(rl.consume('otp_request', 'l:abc')).rejects.toThrow(/unknown tier or key prefix/);
    for (let i = 0; i < 20; i++) await rl.consume('report_download', 'l:x');
    await expect(rl.consume('report_download', 'l:x')).rejects.toMatchObject({ code: 'common.rate_limited' });
    w.advance(3601_000); await rl.consume('report_download', 'l:x');
  });
});
