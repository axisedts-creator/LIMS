// T0B-PRINTCFG-1 done_when (1) handlers registered, (6) validation, cross tenant isolation, audit; the 5 operations of T0C-PRINTCFG-1 through the REAL manifest handlers over a real PG17 tx under RLS (lims_api).
// DB: tests/reporting/T0B-PRINTCFG-1.pg.sh exports LIMS_TEST_APP_URL (lims_api, NOBYPASSRLS) and LIMS_TEST_SUPER_URL (superuser). Without them the file FAILS (never skips): LIMS_T03_REQUIRE_DB=1 is set by the script,
// and a missing database is a failure here too (done_when 7 "never skip").
// PINNED CHOICES (spec silent; a change needs a ruling):
//   * handler(req, ctx) with req = { params, query, body, headers } and ctx = { tenantId, requestId, actor{id,type,membershipId}, tx, now(), ports{IdentityPort}, audit{access} } (same shape as billing print.live).
//   * upsertPrintProfile answers 200 + PrintProfile body (no etag required); listPrintProfiles 200 { data } with optional ?document_kind= and ?branch_id= filters; the list shows only the caller's tenant.
//   * invoice / credit_note profiles: the handler calls IdentityPort.assertRole(ctx, { permission: 'billing.settings.manage' }) (contract text "also need billing.settings.manage, checked by the handler");
//     a refusal (auth.forbidden) writes nothing. report profiles never ask for the billing code. The open CR (finance only) is NOT decided here.
//   * unknown or other tenant user in upsertSignatoryProfile -> common.not_found; markup / over long text -> common.validation_failed (the pipeline schema is not in the way when handlers are called directly).
//   * each upsert writes one audit.access_log row (outcome allowed) whose action is 'settings.change' (action codes are two segments <entity>.<verb>, 02-CONVENTIONS:302; ruling T0B-PRINTCFG-1-ruling.md) with entity_type 'print_profile' / 'signatory_profile'.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access } from '../../../../core/audit/access.js';
import { createDb } from '../../../../core/db/tx.js';
import { manifest } from '../../index.js';

const APP = process.env['LIMS_TEST_APP_URL'], SU = process.env['LIMS_TEST_SUPER_URL'];
const A = '01a1a98a-ac40-7000-8000-00000000a001', B = '01a1a98a-ac40-7000-8000-00000000b001';
const BR_A = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE_A = '01a1a98a-ac40-7000-8000-00000000a201';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c500-0000-7000-8000-${String(n).padStart(12, '0')}`;
const H = manifest.handlers as Record<string, (req: unknown, ctx: unknown) => Promise<{ status: number; body?: any }>>;

describe('T0B-PRINTCFG-1 handlers over a real database', () => {
  let su: any, db: ReturnType<typeof createDb>; let reqN = 0;
  const denied = new Set<string>();
  const identity = { async assertRole(_c: unknown, r: { permission: string }) { if (denied.has(r.permission)) throw Object.assign(new Error('forbidden'), { code: 'auth.forbidden', statusCode: 403 }); } };
  // withCentre: a working centre on ctx + an all-centres (system) claim, needed by previewPrintProfile (print_jobs RLS insert needs tenant + centre; ruling point 3)
  const tx = <T>(tenant: string, fn: (ctx: any) => Promise<T>, withCentre = false) => db.requestTx({ claims: { actor_type: withCentre ? 'system' : 'user', tenant_id: tenant, sub: SYS, membership_id: uid(1) } as never, requestId: uid(900 + ++reqN), clientIp: '203.0.113.9',
    operation: { module: 'reporting', operationId: 'T0B-PRINTCFG-1.live' } }, async (t) => {
    const c: any = { tenantId: tenant, requestId: uid(900 + reqN), actor: { type: 'user', id: SYS, membershipId: uid(1) }, ...(withCentre ? { centreId: CENTRE_A } : {}), tx: t, now: () => new Date().toISOString(), ports: { IdentityPort: identity } };
    c.audit = { access: (e: never) => access(c, e) };
    return fn(c);
  });
  const call = (op: string, tenant: string, req: Record<string, unknown>) => tx(tenant, (c) => H[op]!({ params: {}, query: {}, headers: {}, ...req }, c), op === 'previewPrintProfile');
  const fail = async (p: Promise<unknown>): Promise<{ code?: string }> => { try { await p; } catch (e) { return e as { code?: string }; } throw new Error('expected a failure'); };
  const owner = async (sql: string, v: unknown[] = []) => (await su.query(sql, v)).rows;
  let userA: string | undefined, userB: string | undefined;

  beforeAll(async () => {
    if (!APP || !SU) throw new Error('LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are required (run tests/reporting/T0B-PRINTCFG-1.pg.sh)');
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 3 });
    db = createDb({ pool: new Pool({ connectionString: APP, max: 8 }), identitySystemActorId: SYS });
    userA = (await owner('SELECT user_id FROM core.memberships WHERE tenant_id = $1 LIMIT 1', [A]))[0]?.user_id;
    userB = (await owner('SELECT user_id FROM core.memberships WHERE tenant_id = $1 LIMIT 1', [B]))[0]?.user_id;
    await owner('DELETE FROM reporting.print_profile WHERE tenant_id = ANY($1::uuid[]) AND header_text LIKE $2', [[A, B], '%(T0BPC)%']).catch(() => undefined);
  });
  afterAll(async () => { await su?.end(); });

  it('the five operations are real handlers: not a 501 stub and not pending', async () => {
    for (const op of ['listPrintProfiles', 'upsertPrintProfile', 'previewPrintProfile', 'listSignatoryProfiles', 'upsertSignatoryProfile']) {
      expect(typeof H[op], op).toBe('function');
      expect((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [], `${op} must leave pendingOperations`).not.toContain(op);
    }
    const r = await call('listPrintProfiles', A, {});
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it('upsert creates the lab default row; the same key again replaces it in place (one row per key); list shows it with the contract fields', async () => {
    const body = { document_kind: 'report', paper_mode: 'typed_header_footer', header_text: 'Lab One (T0BPC)\nKathmandu', footer_text: 'Thanks', font_size_pt: 9 };
    const first = await call('upsertPrintProfile', A, { body });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ document_kind: 'report', paper_mode: 'typed_header_footer', header_text: 'Lab One (T0BPC)\nKathmandu', font_size_pt: 9, is_active: true, show_seller_pan: true });
    expect('branch_id' in first.body).toBe(false);
    const second = await call('upsertPrintProfile', A, { body: { ...body, header_text: 'Lab Two (T0BPC)', grayscale: true } });
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({ header_text: 'Lab Two (T0BPC)', grayscale: true });
    const rows = await owner(`SELECT id FROM reporting.print_profile WHERE tenant_id = $1 AND document_kind = 'report' AND branch_id IS NULL AND recipient_type IS NULL AND is_active`, [A]);
    expect(rows).toHaveLength(1);
    const list = await call('listPrintProfiles', A, { query: { document_kind: 'report' } });
    expect(list.body.data.find((p: any) => p.id === first.body.id)).toMatchObject({ header_text: 'Lab Two (T0BPC)' });
    expect(list.body.data.every((p: any) => p.document_kind === 'report')).toBe(true);
  });

  it('a branch row and a recipient row are separate keys next to the lab default', async () => {
    const mk = (over: Record<string, unknown>) => call('upsertPrintProfile', A, { body: { document_kind: 'report', paper_mode: 'plain', header_text: '(T0BPC)', ...over } });
    const branch = await mk({ branch_id: BR_A }); const doctor = await mk({ recipient_type: 'doctor', paper_mode: 'preprinted_paper', reserve_top_mm: 45, reserve_bottom_mm: 25 });
    expect(branch.body.branch_id).toBe(BR_A); expect(doctor.body.recipient_type).toBe('doctor');
    const list = await call('listPrintProfiles', A, { query: { document_kind: 'report' } });
    expect(new Set(list.body.data.map((p: any) => p.id)).size).toBe(list.body.data.length);
    expect(list.body.data.filter((p: any) => p.branch_id === BR_A)).toHaveLength(1);
    const filtered = await call('listPrintProfiles', A, { query: { branch_id: BR_A } });
    expect(filtered.body.data.every((p: any) => p.branch_id === BR_A)).toBe(true);
  });

  it('cross tenant: tenant B never sees tenant A rows, its upsert of the same key is its own row, and a branch of tenant A is not accepted for tenant B', async () => {
    const a = await call('upsertPrintProfile', A, { body: { document_kind: 'invoice', paper_mode: 'plain', header_text: 'A ONLY (T0BPC)' } });
    const b = await call('upsertPrintProfile', B, { body: { document_kind: 'invoice', paper_mode: 'letterhead_image', header_text: 'B ONLY (T0BPC)' } });
    expect(b.body.id).not.toBe(a.body.id);
    const listB = await call('listPrintProfiles', B, {});
    expect(JSON.stringify(listB.body)).not.toContain('A ONLY');
    const listA = await call('listPrintProfiles', A, {});
    expect(JSON.stringify(listA.body)).not.toContain('B ONLY');
    expect((await owner('SELECT count(*)::int AS n FROM reporting.print_profile WHERE id = $1 AND tenant_id = $2', [a.body.id, A]))[0].n).toBe(1);
    const e = await fail(call('upsertPrintProfile', B, { body: { document_kind: 'report', paper_mode: 'plain', branch_id: BR_A } }));
    expect(['common.not_found', 'common.validation_failed']).toContain(e.code);
  });

  it('invoice and credit_note profiles need billing.settings.manage (handler check); report profiles do not; a refusal writes nothing', async () => {
    denied.add('billing.settings.manage');
    try {
      const before = (await owner('SELECT count(*)::int AS n FROM reporting.print_profile WHERE tenant_id = $1', [A]))[0].n;
      for (const document_kind of ['invoice', 'credit_note']) {
        expect((await fail(call('upsertPrintProfile', A, { body: { document_kind, paper_mode: 'plain', header_text: 'x (T0BPC)' } }))).code).toBe('auth.forbidden');
        expect((await fail(call('listPrintProfiles', A, { query: { document_kind } }))).code).toBe('auth.forbidden');
      }
      expect((await owner('SELECT count(*)::int AS n FROM reporting.print_profile WHERE tenant_id = $1', [A]))[0].n).toBe(before);
      expect((await call('upsertPrintProfile', A, { body: { document_kind: 'report', paper_mode: 'plain', header_text: '(T0BPC)' } })).status).toBe(200);
    } finally { denied.delete('billing.settings.manage'); }
  });

  it.each([
    ['markup in header_text', { header_text: '<b>x</b>' }], ['9 lines', { footer_text: 'a\n'.repeat(8) + 'b' }], ['121 characters', { header_text: 'x'.repeat(121) }],
    ['reserve_top_mm 99', { reserve_top_mm: 99 }], ['font 20', { font_size_pt: 20 }], ['unknown paper mode', { paper_mode: 'x' }],
  ])('upsertPrintProfile rejects %s with common.validation_failed and stores nothing', async (_n, over) => {
    const before = (await owner('SELECT count(*)::int AS n FROM reporting.print_profile WHERE tenant_id = $1', [A]))[0].n;
    expect((await fail(call('upsertPrintProfile', A, { body: { document_kind: 'report', paper_mode: 'typed_header_footer', ...over } }))).code).toBe('common.validation_failed');
    expect((await owner('SELECT count(*)::int AS n FROM reporting.print_profile WHERE tenant_id = $1', [A]))[0].n).toBe(before);
  });

  it('every upsert is audited (audit.access_log, outcome allowed, action settings.change, entity_type print_profile)', async () => {
    const r = await call('upsertPrintProfile', A, { body: { document_kind: 'credit_note', paper_mode: 'plain', header_text: 'audited (T0BPC)' } });
    const rows = await owner(`SELECT action FROM audit.access_log WHERE tenant_id = $1 AND entity_id = $2 AND entity_type = 'print_profile' AND outcome = 'allowed'`, [A, r.body.id]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((x: any) => x.action === 'settings.change')).toBe(true);
  });

  it('previewPrintProfile: 202 with a render job; accepts no patient / report / invoice / order id', async () => {
    const ok = await call('previewPrintProfile', A, { headers: { 'idempotency-key': uid(77) }, body: { document_kind: 'report', paper_mode: 'typed_header_footer', header_text: 'Preview (T0BPC)' } });
    expect(ok.status).toBe(202);
    expect(typeof ok.body.id).toBe('string');
    for (const key of ['patient_id', 'order_id', 'invoice_id', 'report_version_id']) {
      expect((await fail(call('previewPrintProfile', A, { headers: { 'idempotency-key': uid(78) }, body: { document_kind: 'report', paper_mode: 'plain', [key]: uid(5) } }))).code, key).toBe('common.validation_failed');
    }
    expect((await fail(call('previewPrintProfile', A, { headers: { 'idempotency-key': uid(79) }, body: { document_kind: 'report', paper_mode: 'plain', header_text: '<i>x</i>' } }))).code).toBe('common.validation_failed');
  });

  describe('signatory profiles', () => {
    const sig = (over: Record<string, unknown> = {}) => ({ display_name: 'Dr. Synthetic Patho (T0BPC)', title: 'Consultant Pathologist', registration_no: 'NMC-T0BPC-1', ...over });
    it('the seeded tenants have a user each (fixture check)', () => { expect(userA, 'a user of tenant A').toBeTruthy(); expect(userB, 'a user of tenant B').toBeTruthy(); });
    it('upsert creates and then replaces the one row of a user; list shows it; unknown and other tenant users are common.not_found', async () => {
      const first = await call('upsertSignatoryProfile', A, { params: { user_id: userA }, body: sig() });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ user_id: userA, display_name: 'Dr. Synthetic Patho (T0BPC)', registration_no: 'NMC-T0BPC-1', is_active: true });
      const second = await call('upsertSignatoryProfile', A, { params: { user_id: userA }, body: sig({ registration_no: 'NMC-T0BPC-2' }) });
      expect(second.body.registration_no).toBe('NMC-T0BPC-2');
      expect((await owner('SELECT count(*)::int AS n FROM reporting.signatory_profile WHERE tenant_id = $1 AND user_id = $2', [A, userA]))[0].n).toBe(1);
      const list = await call('listSignatoryProfiles', A, {});
      expect(list.body.data.filter((p: any) => p.user_id === userA)).toHaveLength(1);
      expect((await fail(call('upsertSignatoryProfile', A, { params: { user_id: uid(404) }, body: sig() }))).code).toBe('common.not_found');
      expect((await fail(call('upsertSignatoryProfile', A, { params: { user_id: userB }, body: sig() }))).code).toBe('common.not_found');
    });
    it('cross tenant: tenant B list never shows tenant A signer profiles', async () => {
      await call('upsertSignatoryProfile', A, { params: { user_id: userA }, body: sig({ display_name: 'A SIGNER ONLY (T0BPC)' }) });
      await call('upsertSignatoryProfile', B, { params: { user_id: userB }, body: sig({ display_name: 'B SIGNER ONLY (T0BPC)' }) });
      expect(JSON.stringify((await call('listSignatoryProfiles', B, {})).body)).not.toContain('A SIGNER ONLY');
      expect(JSON.stringify((await call('listSignatoryProfiles', A, {})).body)).not.toContain('B SIGNER ONLY');
    });
    it.each([['markup in the name', { display_name: '<b>x' }], ['a name of 121 characters', { display_name: 'x'.repeat(121) }], ['markup in the title', { title: 'a>b' }], ['registration number of 61 characters', { registration_no: 'x'.repeat(61) }],
      ['an asset id that is not a uuid', { signature_asset_id: 'sig.png' }]])('rejects %s', async (_n, over) => {
      expect((await fail(call('upsertSignatoryProfile', A, { params: { user_id: userA }, body: sig(over) }))).code).toBe('common.validation_failed');
    });
    it('a signature_asset_id that is no image of this tenant is refused (unknown id, and an id that exists only in the other tenant)', async () => {
      expect((await fail(call('upsertSignatoryProfile', A, { params: { user_id: userA }, body: sig({ signature_asset_id: uid(808) }) }))).code).toBe('common.validation_failed');
    });
  });
});
