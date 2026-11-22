// T0D-FIX-9 (LD-455, founder order 2026-11-22 22:06 NPT) previewPrintProfile: POST /v1/reporting/print-profiles/preview answered 500 common.internal twice on the live tenant
// (request ids 01a20344-ed18-71c0-a027-d9a883db286d, 01a20347-113d-7e4c-aa5f-38b0ae6e283e; 7 and 8 database calls, then the failure).
// CAUSE FOUND BY THE TESTER: printProfile.service.ts previewPrintProfile needs a working centre (`c.centreId ?? c.actor.centreId`, print_jobs RLS insert needs tenant + centre) and throws
// LimsError('common.internal') (500) when none. The real request context (core/pipeline/index.ts buildCtx) sets neither ctx.centreId nor actor.centreId (actor = type, id, membershipId,
// supportSessionId), so EVERY real call fails. The existing live test (handlers.live.test.ts) hid it by injecting centreId into ctx by hand.
// These tests call the REAL handlers with a context shaped exactly like buildCtx (no centreId) over a recording fake tx. The contract answers 202 + PrintJob.
// CONTRACT RULE (task): the 500 ends as the bug fixed or a typed 4xx for bad input, never a 500. Where the caller's centre must come from is the writer's choice
// (IdentityPort.getActor().centreScope is the only centre source in the context; the tester pins ONLY the single-centre case below). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { printProfileHandlers } from '../../handlers/printProfile.handlers.js';

const T_A = '01a1a98a-ac40-7000-8000-00000000a001', T_B = '01a1a98a-ac40-7000-8000-00000000b001';
const CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', CENTRE_B = '01a1a98a-ac40-7000-8000-00000000b201';
const USER = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '0190c500-0000-7000-8000-000000000001';

interface Opts { tenant?: string; denied?: string[]; scope?: { all: boolean; centreIds: string[] } }
function ctx(o: Opts = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const roleCalls: string[] = [];
  const tenant = o.tenant ?? T_A;
  const scope = o.scope ?? { all: false, centreIds: [tenant === T_A ? CENTRE : CENTRE_B] };
  const IdentityPort = {
    async assertRole(_c: unknown, r: { permission: string }) { roleCalls.push(r.permission); if (o.denied?.includes(r.permission)) throw new LimsError('auth.forbidden'); },
    async getActor() { return { centreScope: scope, branchIds: [], permissions: [], mfaLevel: 'aal2' }; },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
  };
  // exactly the keys core/pipeline/index.ts buildCtx gives a tenant user: NO centreId, NO actor.centreId
  const c: any = {
    tenantId: tenant, actor: Object.freeze({ type: 'user', id: USER, membershipId: MEMBERSHIP }), requestId: '01a1a98a-ac40-7000-8000-0000000fff01',
    tx: { async query(text: string, values: unknown[] = []) { calls.push({ text, values }); return { rows: [] as any[] }; } },
    now: () => '2026-11-22T06:00:00.000Z', ports: { IdentityPort },
  };
  c.audit = { access: async () => undefined };
  return { c, calls, roleCalls };
}
const H = printProfileHandlers['previewPrintProfile']!;
const send = (c: unknown, body: unknown) => (H as any)({ params: {}, query: {}, headers: {}, body }, c) as Promise<{ status: number; body: any }>;
const caught = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } return undefined; };

/** The body previewPrintProfile in apps/web write.server.ts sends: profileBody(o, true), every contract field, no branch_id. */
const WEB_BODY = { document_kind: 'report', paper_mode: 'typed_header_footer', header_text: 'Synthetic Lab (SYNTHETIC)\nKathmandu', footer_text: 'Thank you (SYNTHETIC)',
  reserve_top_mm: 0, reserve_bottom_mm: 0, show_logo: false, show_seller_pan: true, grayscale: false, font_size_pt: 10 };
const insertOf = (calls: Array<{ text: string; values: unknown[] }>) => calls.find((x) => /INSERT INTO reporting\.print_jobs/i.test(x.text));

describe('previewPrintProfile with the context the real pipeline builds (no centre on ctx)', () => {
  it('a single-centre caller + the exact web body -> 202 with a rendering PrintJob (was 500 common.internal)', async () => {
    const { c, calls } = ctx();
    const r = await send(c, WEB_BODY);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ state: 'rendering' });
    expect(typeof r.body.id).toBe('string');
    const ins = insertOf(calls);
    expect(ins, 'a print_jobs row is inserted').toBeTruthy();
    expect(ins!.values).toContain(CENTRE);
    expect(ins!.values).toContain(T_A);
  });
  it('invoice and credit_note kinds also answer 202 for a caller who holds billing.settings.manage', async () => {
    for (const document_kind of ['invoice', 'credit_note']) {
      const { c } = ctx();
      expect((await send(c, { ...WEB_BODY, document_kind })).status).toBe(202);
    }
  });
  it('only the contract fields: the minimal body (document_kind + paper_mode) answers 202', async () => {
    const { c } = ctx();
    expect((await send(c, { document_kind: 'report', paper_mode: 'plain' })).status).toBe(202);
  });
  it('NEVER a 500: an all-centres caller and a caller with no centre answer 202 or a typed 4xx', async () => {
    for (const scope of [{ all: true, centreIds: [] as string[] }, { all: false, centreIds: [] as string[] }]) {
      const { c } = ctx({ scope });
      const e = await caught(send(c, WEB_BODY));
      if (e) { expect(e).toBeInstanceOf(LimsError); expect(e.code).not.toBe('common.internal'); expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); }
    }
  });
  it('the job payload carries the caller tenant and the draft profile (no id of any kind), never the other tenant', async () => {
    const { c, calls } = ctx();
    await send(c, WEB_BODY);
    const enq = calls.find((x) => /enqueue_job/i.test(x.text))!;
    expect(enq, 'the render job is enqueued').toBeTruthy();
    const payload = JSON.parse(String(enq.values[1]));
    expect(payload.tenant_id).toBe(T_A);
    expect(payload.document_kind).toBe('report');
    expect(payload.print_profile.header_text).toBe(WEB_BODY.header_text);
    expect(JSON.stringify(calls.map((x) => x.values))).not.toContain(T_B);
  });
  it('other tenant: tenant B gets its own centre and no statement mentions tenant A', async () => {
    const { c, calls } = ctx({ tenant: T_B });
    expect((await send(c, WEB_BODY)).status).toBe(202);
    const all = JSON.stringify(calls.map((x) => x.values));
    expect(all).toContain(T_B);
    expect(all).toContain(CENTRE_B);
    expect(all).not.toContain(T_A);
    expect(all).not.toContain(CENTRE);
  });
});

describe('previewPrintProfile: permission first, bad input typed, nothing stored on a refusal', () => {
  it('without reporting.settings.manage -> auth.forbidden and no statement', async () => {
    const { c, calls, roleCalls } = ctx({ denied: ['reporting.settings.manage'] });
    const e = await caught(send(c, WEB_BODY));
    expect(e?.code).toBe('auth.forbidden');
    expect(calls).toEqual([]);
    expect(roleCalls[0]).toBe('reporting.settings.manage');
  });
  it('invoice / credit_note without billing.settings.manage -> auth.forbidden and no print job', async () => {
    for (const document_kind of ['invoice', 'credit_note']) {
      const { c, calls } = ctx({ denied: ['billing.settings.manage'] });
      expect((await caught(send(c, { ...WEB_BODY, document_kind })))?.code).toBe('auth.forbidden');
      expect(insertOf(calls)).toBeUndefined();
    }
  });
  it.each([
    ['an order id', { order_id: '01a1a98a-ac40-7000-8000-00000000a301' }], ['a patient id', { patient_id: '01a1a98a-ac40-7000-8000-00000000a302' }],
    ['a report id', { report_id: '01a1a98a-ac40-7000-8000-00000000a303' }], ['branch_id (not in the preview request)', { branch_id: '01a1a98a-ac40-7000-8000-00000000a101' }],
    ['is_active (not in the preview request)', { is_active: true }], ['markup in header_text', { header_text: '<b>x</b>' }], ['9 lines in footer_text', { footer_text: 'a\n'.repeat(8) + 'b' }],
    ['a 121 character header line', { header_text: 'x'.repeat(121) }], ['font 20', { font_size_pt: 20 }], ['reserve_top_mm 99', { reserve_top_mm: 99 }],
    ['an unknown paper mode', { paper_mode: 'x' }], ['an unknown document kind', { document_kind: 'receipt' }],
  ])('bad input (%s) -> common.validation_failed 400, no statement', async (_n, over) => {
    const { c, calls } = ctx();
    const e = await caught(send(c, { ...WEB_BODY, ...over }));
    expect(e?.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
  it.each([[undefined], [null], [[]], ['x']])('a body that is not an object (%j) -> common.validation_failed, no statement', async (b) => {
    const { c, calls } = ctx();
    expect((await caught(send(c, b)))?.code).toBe('common.validation_failed');
    expect(calls).toEqual([]);
  });
  it('a request without tenant or actor -> auth.unauthenticated, never 500', async () => {
    const e = await caught((H as any)({ params: {}, query: {}, headers: {}, body: WEB_BODY }, { ports: { IdentityPort: { assertRole: async () => undefined } } }));
    expect(e?.code).toBe('auth.unauthenticated');
  });
});
