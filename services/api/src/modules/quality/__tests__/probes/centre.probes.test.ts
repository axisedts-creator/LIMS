// C9 T-25 — S-02 / AB-07 handler half (07-SECURITY §5; REQ-SEC-040/041; 08 A17 P-16): a USER scoped to centre A1 (allCentres:false, centreIds:[A1]) against an item of centre A2 through the REAL
// listTatAlerts / getTatAlert / acknowledgeTatAlert handlers + real IdentityPort. RLS (`__tenant_centre`) hides the A2 row, modelled as a tx whose SELECTs return no rows (nothing here decides
// visibility itself: the handlers must not widen it) -> getTatAlert / acknowledgeTatAlert 404 common.not_found identical to a missing id, list = empty page, no write SQL, no access-log row,
// no centre from claims/body replaces the RLS decision. The live variant (real RLS, user claims with membership_centres) is centre.live.test.ts.
// Fails now if: a handler answers 200 for an invisible item, writes before loading it, differs between "A2's id" and "missing id", or logs an access row.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CENTRE_A1, CENTRE_A2, TENANT_A, fire, loadManifest, makeHarness, opById, requestFor, seen, uid } from './kit.js';

let handlers: Record<string, (...a: any[]) => Promise<any>>;
beforeAll(async () => { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); handlers = (await loadManifest()).handlers; });
const A1_USER = { permissions: ['quality.tat_alert.read', 'quality.tat_alert.ack'], aal: 'aal1', allCentres: false, centreIds: [CENTRE_A1] };
const WRITE_SQL = /^\s*(insert|update|delete|merge|truncate)\b/i;
const WITH_WRITE = /\b(insert\s+into|update\s+quality\.|delete\s+from)\b/i;   // the ack is ONE `WITH u AS (UPDATE ...)` statement: catch writes inside a CTE too

describe('S-02 a user of centre A1 against an item of centre A2 (invisible under RLS)', () => {
  it('getTatAlert (#49): 404 common.not_found, the id is not echoed, nothing written, no access-log row', async () => {
    const op = opById('getTatAlert'), h = makeHarness({ ...A1_USER }, op.id), req = requestFor(op, { ids: { tat_item_id: uid() } });
    const out = await fire(handlers[op.id]!, req, h.ctx);
    expect(out.reply, `answered ${out.reply?.status}`).toBeUndefined();
    expect(out.error?.code, String(out.error?.message)).toBe('common.not_found');
    expect(out.error?.statusCode).toBe(404);
    expect(seen(out.error)).not.toContain(String(req.params['tat_item_id']));
    expect(h.queries.filter((q) => WRITE_SQL.test(q.text) || WITH_WRITE.test(q.text))).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('acknowledgeTatAlert (#50): 404 (not 409/412/200), no UPDATE and no ack INSERT is issued, no access-log row', async () => {
    const op = opById('acknowledgeTatAlert'), h = makeHarness({ ...A1_USER }, op.id), req = requestFor(op, { ids: { tat_item_id: uid() }, body: { note: 'synthetic' } });
    const out = await fire(handlers[op.id]!, req, h.ctx);
    expect(out.reply, `answered ${out.reply?.status}`).toBeUndefined();
    expect(out.error?.code, String(out.error?.message)).toBe('common.not_found');
    expect(out.error?.statusCode).toBe(404);
    expect(seen(out.error)).not.toContain(String(req.params['tat_item_id']));
    expect(h.queries.filter((q) => WITH_WRITE.test(q.text)), 'the guarded UPDATE/INSERT must not even be attempted for an invisible row').toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('listTatAlerts (#48): 200 with an empty page, also when the A2 centre is named as a filter (never data, never an error that confirms the centre)', async () => {
    const op = opById('listTatAlerts');
    for (const query of [{}, { centre_id: CENTRE_A2 }]) {
      const h = makeHarness({ ...A1_USER }, op.id), req = requestFor(op, { query });
      const out = await fire(handlers[op.id]!, req, h.ctx);
      expect(out.error, seen(out.error)).toBeUndefined();
      expect(out.reply?.status).toBe(200);
      expect(out.reply?.body?.data).toEqual([]);
      expect(JSON.stringify(out.reply?.body)).not.toContain(CENTRE_A2);
      expect(h.queries.filter((q) => WRITE_SQL.test(q.text))).toEqual([]);
    }
  });

  it('"A2\'s item id" and "an id that never existed" are indistinguishable (no existence oracle) on #49 and #50', async () => {
    for (const id of ['getTatAlert', 'acknowledgeTatAlert']) {
      const op = opById(id);
      const run = async () => (await fire(handlers[op.id]!, requestFor(op, { ids: { tat_item_id: uid() }, body: { note: 'synthetic' } }), makeHarness({ ...A1_USER }, op.id).ctx)).error;
      const [a, b] = [await run(), await run()];
      expect([a?.code, a?.statusCode, a?.message], id).toEqual([b?.code, b?.statusCode, b?.message]);
    }
  });

  it('every statement is bound to the caller\'s tenant and no centre or tenant taken from the request (query/body) reaches a write', async () => {
    const op = opById('acknowledgeTatAlert'), h = makeHarness({ ...A1_USER }, op.id);
    const req = requestFor(op, { ids: { tat_item_id: uid() }, body: { note: 'synthetic', centre_id: CENTRE_A2, tenant_id: uid() } });
    await fire(handlers[op.id]!, req, h.ctx);   // unknown body fields are a 400 (S-03) or the 404; either way nothing is written
    for (const q of h.queries) { expect(JSON.stringify(q.values)).toContain(TENANT_A); expect(JSON.stringify(q.values)).not.toContain(CENTRE_A2); }
    expect(h.queries.filter((q) => WITH_WRITE.test(q.text))).toEqual([]);
  });
});
