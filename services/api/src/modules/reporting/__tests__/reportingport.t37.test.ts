// C6-T37 — ReportingPort partner/patient reads: openReleasedReportFile (AC-15.3) and redeemPortalLinkForApp (AC-15.4) against the REAL ports/ReportingPort.impl.ts.
// Spec: 01-PRD AC-15.3/15.4; 02-TRD §7.1 (redeem via DEFINER app.reporting_redeem_link_for_app, ctx.commitOnError() on every no-row result, A19 P-42);
// 03-IC §4.7 + §13.3 (DEFINER signature); 07-SECURITY item 4a, 8a (zero SmartReportPort calls); 08 A13 D-30; 08 A2.3 (smartSummary = smart_summary_json snapshot).
// Harness: reportingport.helpers.ts (T21 in-memory fake). That fake models partner RLS only and has no DEFINER, so THIS file adds, around ctx.tx:
//   - patient RLS (05-SCHEMA §4 `__patient`): report_versions.patient_id = ANY(engagement_patient_ids) AND status IN ('released','superseded'); qr_tokens follow;
//   - the DEFINER `app.reporting_redeem_link_for_app(bytea, bytea)` with the semantics of the C0 SQL (migration 20261105001900 §6.2): no row for an invalid / wrong-kind /
//     expired / revoked / locked link (no counter change); phone mismatch => redeem_failures + 1 and no row; match => (tenant_id, patient_id, report_id, version_no, released_at).
//     The fake returns released_at as a Date (like node-postgres) so the impl must convert it to an ISO-8601 UTC string.
// ASSUMED impl contract (spec-given): createReportingPort({env}) exposes openReleasedReportFile(ctx,{reportId,versionNo}) and redeemPortalLinkForApp(ctx,{linkToken,phoneE164});
// the impl hashes with sha256(utf8) (domain/tokens.hashToken), calls the DEFINER with two 32-byte Buffers through ctx.tx, and calls ctx.commitOnError() before throwing.
// Synthetic data only.
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CENTRE_A, idN } from './portal.helpers.js';
import { NOW, PAT, PAT2, P1, P2, TENANT_A, TENANT_B, id, isoDay, makeReportingWorld, rejection, ver } from './reportingport.helpers.js';

vi.setConfig({ testTimeout: 30_000 });
const A = TENANT_A, B = TENANT_B;
const R = (n: number) => id(0x700 + n);
const O = (n: number) => id(0x800 + n);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const PHONE = '+9779800000010', OTHER_PHONE = '+9779800000011';
const VISIBLE = ['released', 'superseded'];
const shape = (e: any) => JSON.stringify({ name: e?.name, code: e?.code, message: e?.message, statusCode: e?.statusCode, errors: e?.errors ?? e?.fields ?? null });

type World = Awaited<ReturnType<typeof makeReportingWorld>>;

/** ctx for a patient actor: patient RLS applied on top of the T21 fake (the fake only knows partner RLS). */
function patientCtx(w: World, patientIds: string[], key = 'A:patient:default', over: Record<string, unknown> = {}) {
  const ctx: any = w.harness.ctxFor(key, over as any);
  const inner = ctx.tx.query.bind(ctx.tx);
  ctx.tx.query = async (text: string, values: unknown[] = []) => {
    const r = await inner(text, values);
    if (!/^\s*select/i.test(text)) return r;
    const versions = w.db.store['report_versions']!;
    const ok = (v: any) => !!v && patientIds.includes(v['patient_id']) && VISIBLE.includes(v['status']);
    if (/from\s+reporting\.report_versions/i.test(text)) return { rows: r.rows.filter(ok) };
    if (/from\s+reporting\.qr_tokens/i.test(text)) return { rows: r.rows.filter((q: any) => ok(versions.find((v) => v['id'] === q['report_version_id']))) };
    if (/from\s+reporting\.reports/i.test(text)) return { rows: r.rows.filter((x: any) => patientIds.includes(x['patient_id']) && versions.some((v) => v['report_id'] === x['id'] && ok(v))) };
    return { rows: [] };
  };
  return ctx;
}

function smartSpy() {
  const calls: string[] = [];
  return { calls, port: new Proxy({}, { get: (_t, m) => (...a: unknown[]) => { void a; calls.push(String(m)); throw new Error(`SmartReportPort.${String(m)} called`); } }) };
}

// ------------------------------------------------------------------------------------------------ openReleasedReportFile (AC-15.3)
async function fileWorld() {
  const w = await makeReportingWorld();
  await w.harness.seed({
    reports: [
      ver(A, { id: id(0x901), reportId: R(1), orderId: O(1), partnerId: P1, releasedAt: isoDay(2) }),                                       // P1, released
      ver(A, { id: id(0x902), reportId: R(2), orderId: O(2), partnerId: P2, releasedAt: isoDay(3) }),                                       // P2, released
      ver(A, { id: id(0x903), reportId: R(3), orderId: O(3), partnerId: P1, versionNo: 1, status: 'superseded', releasedAt: isoDay(1) }),   // P1, v1 superseded
      ver(A, { id: id(0x904), reportId: R(3), orderId: O(3), partnerId: P1, versionNo: 2, kind: 'amended', releasedAt: isoDay(2), smart: true }),
      ver(A, { id: id(0x905), reportId: R(4), orderId: O(4), partnerId: P1, dbStatus: 'rendered', released: false, releasedAt: null }),      // P1, NOT released
      ver(A, { id: id(0x906), reportId: R(5), orderId: O(5), partnerId: P1, dbStatus: 'discarded', released: false, releasedAt: null }),
      ver(A, { id: id(0x907), reportId: R(6), orderId: O(6), partnerId: null, patientId: PAT2, releasedAt: isoDay(4) }),                    // other patient, no partner
      ver(B, { id: id(0x908), reportId: R(7), orderId: O(7), partnerId: P1, releasedAt: isoDay(5) }),                                       // other tenant, same partner id
    ],
    partnerOfActor: { [w.harness.ctxFor('A:partner:p1').actor.id]: P1 },
  });
  return w;
}
const open = (w: World, ctx: any, reportId: string, versionNo = 1) => w.harness.impl.openReleasedReportFile(ctx, { reportId, versionNo });

describe('openReleasedReportFile: partner actor (AC-15.3, 07-SECURITY 4a)', () => {
  it('own released report: ReleasedReportFile with an internal signed URL, TTL <= 300 s, bucket reports, path = pdf_object_path', async () => {
    const w = await fileWorld(); const ctx = w.harness.ctxFor('A:partner:p1');
    const f = await open(w, ctx, R(1));
    expect(f).toMatchObject({ reportVersionId: id(0x901), reportId: R(1), versionNo: 1, status: 'valid', contentType: 'application/pdf', byteSize: 10, sha256: 'a'.repeat(64) });
    expect(typeof f.signedUrl).toBe('string'); expect(f.signedUrl.length).toBeGreaterThan(0);
    expect(w.signed).toEqual([{ bucket: 'reports', path: `${A}/reports/${R(1)}/v1.pdf`, ttl: expect.any(Number) }]);
    expect(w.signed[0]!.ttl).toBeLessThanOrEqual(300); expect(w.signed[0]!.ttl).toBeGreaterThan(0);
    const life = Date.parse(f.expiresAt) - Date.parse(ctx.now());
    expect(life).toBeGreaterThan(0); expect(life).toBeLessThanOrEqual(300_000);
    expect(f.expiresAt).toBe(new Date(Date.parse(f.expiresAt)).toISOString());
  });

  it("another partner's report, an unreleased/discarded version, an unknown report, a missing version number and another tenant's report are ONE indistinguishable common.not_found", async () => {
    const w = await fileWorld(); const ctx = () => w.harness.ctxFor('A:partner:p1');
    const denied = [[R(2), 1], [R(4), 1], [R(5), 1], [id(0xdead), 1], [R(1), 2], [R(3), 3], [R(7), 1]] as const;
    const errs: any[] = [];
    for (const [rid, v] of denied) errs.push(await rejection(open(w, ctx(), rid, v)));
    for (const e of errs) expect(e.code).toBe('common.not_found');
    expect(new Set(errs.map(shape)).size).toBe(1);
    expect(w.signed).toEqual([]);                                                       // no URL is ever minted for a denied read
  });

  it('a superseded version is readable and reported as status superseded; the current version is valid', async () => {
    const w = await fileWorld(); const ctx = () => w.harness.ctxFor('A:partner:p1');
    expect((await open(w, ctx(), R(3), 1)).status).toBe('superseded');
    expect((await open(w, ctx(), R(3), 2)).status).toBe('valid');
  });

  it('visibility comes from the database policy: the read goes through ctx.tx, is a tenant-scoped SELECT, and never filters on the partner id in SQL', async () => {
    const w = await fileWorld(); const ctx = w.harness.ctxFor('A:partner:p1');
    const before = w.reads.length; const writes = w.db.writes().length;
    await open(w, ctx, R(1));
    const mine = w.reads.slice(before);
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) {
      expect(s.text).toMatch(/^\s*select\b/i); expect(s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
      expect(s.values).toContain(A); expect(s.values).not.toContain(P1); expect(s.text).not.toContain(P1);
    }
    expect(w.db.writes().length).toBe(writes);
  });
});

describe('openReleasedReportFile: smartSummary snapshot (08 A2.3/A2.8; 07-SECURITY 8a)', () => {
  it('partner: smartSummary = smart_summary_json of THAT version when set; the key is absent when NULL; zero SmartReportPort calls', async () => {
    const w = await fileWorld(); const spy = smartSpy();
    const ctx = () => w.harness.ctxFor('A:partner:p1', { ports: { SmartReportPort: spy.port } } as any);
    const withSmart = await open(w, ctx(), R(3), 2);
    expect(withSmart.smartSummary).toEqual({ sections: ['synthetic'] });
    const without = await open(w, ctx(), R(1));
    expect('smartSummary' in without ? without.smartSummary : undefined).toBeUndefined();
    expect(spy.calls).toEqual([]);
    expect(w.reads.some((s) => /smart_summary_json/.test(s.text))).toBe(true);          // the snapshot is read from the version row, not rebuilt
  });

  it('patient: same snapshot from the version row; zero SmartReportPort calls', async () => {
    const w = await makeReportingWorld(); const spy = smartSpy();
    await w.harness.seed({ reports: [ver(A, { id: id(0xa01), reportId: R(20), orderId: O(20), smart: true, releasedAt: isoDay(2) })] });
    const ctx = patientCtx(w, [PAT], 'A:patient:default', { ports: { SmartReportPort: spy.port } });
    expect((await open(w, ctx, R(20))).smartSummary).toEqual({ sections: ['synthetic'] });
    expect(spy.calls).toEqual([]);
  });
});

describe('openReleasedReportFile: patient actor (AC-15.3, 07-SECURITY 4a)', () => {
  async function pw() {
    const w = await makeReportingWorld();
    await w.harness.seed({ reports: [
      ver(A, { id: id(0xb01), reportId: R(30), orderId: O(30), releasedAt: isoDay(2) }),                                           // PAT, released
      ver(A, { id: id(0xb02), reportId: R(31), orderId: O(31), patientId: PAT2, releasedAt: isoDay(3) }),                          // other patient
      ver(A, { id: id(0xb03), reportId: R(32), orderId: O(32), dbStatus: 'rendered', released: false, releasedAt: null }),         // PAT, unreleased
      ver(A, { id: id(0xb04), reportId: R(33), orderId: O(33), versionNo: 1, status: 'superseded', releasedAt: isoDay(1) }),
      ver(A, { id: id(0xb05), reportId: R(33), orderId: O(33), versionNo: 2, kind: 'amended', releasedAt: isoDay(2) }),
    ] });
    return w;
  }
  it('own released / superseded versions open; another patient\'s, an unreleased and an unknown report are the same common.not_found', async () => {
    const w = await pw(); const ctx = () => patientCtx(w, [PAT]);
    expect(await open(w, ctx(), R(30))).toMatchObject({ reportId: R(30), status: 'valid', contentType: 'application/pdf' });
    expect((await open(w, ctx(), R(33), 1)).status).toBe('superseded');
    const errs = [await rejection(open(w, ctx(), R(31))), await rejection(open(w, ctx(), R(32))), await rejection(open(w, ctx(), id(0xdead)))];
    for (const e of errs) expect(e.code).toBe('common.not_found');
    expect(new Set(errs.map(shape)).size).toBe(1);
    expect(w.signed.length).toBe(2);
  });
  it('a patient with several linked patient ids (engagement_patient_ids) can open any of them, nothing else', async () => {
    const w = await pw(); const ctx = () => patientCtx(w, [PAT, PAT2]);
    expect((await open(w, ctx(), R(31))).reportId).toBe(R(31));
    const lone = patientCtx(w, [PAT2]);
    expect((await rejection(open(w, lone, R(30)))).code).toBe('common.not_found');
  });
  it('getReleasedReports as a patient lists only its own released/superseded versions whatever filter it asks for', async () => {
    const w = await pw();
    const ctx = () => patientCtx(w, [PAT]);
    const mine = (await w.harness.impl.getReleasedReports(ctx(), { filter: { patientId: PAT, includeSuperseded: true } })).items.map((r: any) => `${r.reportId}:${r.versionNo}`).sort();
    expect(mine).toEqual([`${R(30)}:1`, `${R(33)}:1`, `${R(33)}:2`].sort());
    expect((await w.harness.impl.getReleasedReports(ctx(), { filter: { patientId: PAT2 } })).items).toEqual([]);
    expect((await w.harness.impl.getReleasedReports(ctx(), { filter: { orderId: O(31) } })).items).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ redeemPortalLinkForApp (AC-15.4)
async function redeemWorld() {
  const w = await makeReportingWorld();
  await w.harness.seed({ reports: [ver(A, { id: id(0xc01), reportId: R(40), orderId: O(40), releasedAt: isoDay(3) })] });
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const links = () => w.db.store['portal_links']!;

  /** The DEFINER, mirroring migration 20261105001900 app.reporting_redeem_link_for_app. */
  function definer(values: unknown[]): Array<Record<string, any>> {
    const [tok, phone] = values as [Buffer, Buffer];
    if (!Buffer.isBuffer(tok) || tok.length !== 32 || !Buffer.isBuffer(phone) || phone.length !== 32) return [];
    const now = Date.parse(w.now());
    const l = links().find((x) => Buffer.isBuffer(x['token_sha256']) && x['token_sha256'].equals(tok) && x['revoked_at'] == null && Date.parse(x['expires_at']) > now
      && x['recipient_kind'] === 'patient' && ['sms', 'whatsapp'].includes(x['channel']) && x['purpose'] === 'report');
    if (!l || l['redeem_failures'] >= 5) return [];
    if (!(Buffer.isBuffer(l['destination_sha256']) && l['destination_sha256'].equals(phone))) { l['redeem_failures'] += 1; l['version'] += 1; l['updated_at'] = w.now(); return []; }
    const rep = w.db.store['reports']!.find((r) => r['tenant_id'] === l['tenant_id'] && r['id'] === l['report_id'])!;
    const v = w.db.store['report_versions']!.find((x) => x['tenant_id'] === l['tenant_id'] && x['report_id'] === l['report_id'] && x['status'] === 'released')!;
    return [{ tenant_id: l['tenant_id'], patient_id: rep['patient_id'], report_id: rep['id'], version_no: v['version_no'], released_at: new Date(v['released_at']) }];
  }

  function mkLink(over: Record<string, any> = {}) {
    const token = randomBytes(16).toString('base64url');
    const row = w.db.insert('portal_links', { tenant_id: A, centre_id: CENTRE_A, report_id: R(40), bound_version_no: 1, channel: 'sms', recipient_kind: 'patient', destination_sha256: sha(PHONE),
      destination_masked: '+97798*****10', patient_display_snapshot: 'T*** P*** 0001', token_sha256: sha(token), expires_at: new Date(Date.parse(NOW) + 30 * 86_400_000).toISOString(),
      created_by: idN(0x4001), updated_by: idN(0x4001), ...over });
    return { token, row };
  }
  const ctxFor = (key = 'A:patient:default') => {
    const ctx: any = w.harness.ctxFor(key);
    const state = { commits: 0 }; ctx.commitOnError = vi.fn(() => { state.commits++; });
    const inner = ctx.tx.query.bind(ctx.tx);
    ctx.tx.query = async (text: string, values: unknown[] = []) => {
      if (/\bapp\.reporting_redeem_link_for_app\s*\(/i.test(text)) { calls.push({ text, values: [...values] }); return { rows: definer(values) }; }
      return inner(text, values);
    };
    return Object.assign(ctx, { __state: state });
  };
  const redeem = (ctx: any, input: unknown) => w.harness.impl.redeemPortalLinkForApp(ctx, input);
  const snap = (row: Record<string, any>) => JSON.stringify(row);
  return { w, calls, mkLink, ctxFor, redeem, snap };
}
type RW = Awaited<ReturnType<typeof redeemWorld>>;
/** Everything but the failure counter (+ its bookkeeping) is unchanged. */
const sameButCounter = (before: string, row: Record<string, any>) => {
  const { redeem_failures: _f, version: _v, updated_at: _u, ...rest } = JSON.parse(before); const { redeem_failures: _f2, version: _v2, updated_at: _u2, ...now } = JSON.parse(JSON.stringify(row));
  void _f; void _v; void _u; void _f2; void _v2; void _u2;
  return JSON.stringify(rest) === JSON.stringify(now);
};

describe('redeemPortalLinkForApp: success (AC-15.4, 03-IC §4.7)', () => {
  it('right link + right phone => { patientId, reportId, versionNo, releasedAt (ISO UTC) } and nothing else', async () => {
    const t = await redeemWorld(); const { token } = t.mkLink();
    const out = await t.redeem(t.ctxFor(), { linkToken: token, phoneE164: PHONE });
    expect(out).toEqual({ patientId: PAT, reportId: R(40), versionNo: 1, releasedAt: isoDay(3) });
    expect(Object.keys(out).sort()).toEqual(['patientId', 'releasedAt', 'reportId', 'versionNo']);
  });

  it('calls the DEFINER with exactly sha256(linkToken) and sha256(phoneE164) as 32-byte buffers; plaintext token and phone never reach SQL text or params', async () => {
    const t = await redeemWorld(); const { token } = t.mkLink(); const ctx = t.ctxFor();
    await t.redeem(ctx, { linkToken: token, phoneE164: PHONE });
    expect(t.calls).toHaveLength(1);
    const [a, b] = t.calls[0]!.values as Buffer[];
    expect(Buffer.isBuffer(a) && a.length === 32 && a.equals(sha(token))).toBe(true);
    expect(Buffer.isBuffer(b) && b.length === 32 && b.equals(sha(PHONE))).toBe(true);
    expect(t.calls[0]!.values).toHaveLength(2);
    for (const s of [...t.w.reads, ...t.calls]) { const blob = JSON.stringify({ t: s.text, v: s.values }); expect(blob).not.toContain(token); expect(blob).not.toContain(PHONE); }
  });

  it('never consumes, extends or reveals the link: the row is byte-identical after any number of redemptions; the impl itself writes nothing', async () => {
    const t = await redeemWorld(); const { token, row } = t.mkLink(); const before = t.snap(row); const writes = t.w.db.writes().length;
    const first = await t.redeem(t.ctxFor(), { linkToken: token, phoneE164: PHONE });
    const second = await t.redeem(t.ctxFor(), { linkToken: token, phoneE164: PHONE });
    expect(second).toEqual(first);
    expect(t.snap(row)).toBe(before);
    expect(row['use_count']).toBe(0); expect(row['last_used_at']).toBeNull(); expect(row['revoked_at']).toBeNull(); expect(row['redeem_failures']).toBe(0);
    expect(t.w.db.writes().length).toBe(writes);
  });

  it('a valid redemption after failures keeps the counter (a success does not reset it)', async () => {
    const t = await redeemWorld(); const { token, row } = t.mkLink();
    for (let i = 0; i < 2; i++) await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: OTHER_PHONE }));
    await t.redeem(t.ctxFor(), { linkToken: token, phoneE164: PHONE });
    expect(row['redeem_failures']).toBe(2);
  });
});

describe('redeemPortalLinkForApp: every failure is the same reporting.link_invalid, link otherwise unchanged (AC-15.4, 07-SECURITY 4a)', () => {
  const cases: Array<[string, Record<string, any>]> = [
    ['referrer link', { recipient_kind: 'referrer' }],
    ['centre link', { recipient_kind: 'centre' }],
    ['partner link', { recipient_kind: 'partner' }],
    ['expired link', { expires_at: new Date(Date.parse(NOW) - 1000).toISOString() }],
    ['revoked link', { revoked_at: NOW }],
    ['e-mail channel link', { channel: 'email', destination_sha256: sha('x@example.invalid') }],
    ['print QR link', { channel: 'print_qr' }],
    ['dues-only link', { purpose: 'dues' }],
  ];
  for (const [name, over] of cases) {
    it(`${name}: reporting.link_invalid, link unchanged (even with the right phone)`, async () => {
      const t = await redeemWorld(); const { token, row } = t.mkLink(over); const before = t.snap(row);
      const e = await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: PHONE }));
      expect(e.code).toBe('reporting.link_invalid');
      expect(t.snap(row)).toBe(before);
    });
  }

  it('unknown token: reporting.link_invalid', async () => {
    const t = await redeemWorld(); t.mkLink();
    expect((await rejection(t.redeem(t.ctxFor(), { linkToken: randomBytes(16).toString('base64url'), phoneE164: PHONE }))).code).toBe('reporting.link_invalid');
  });

  it('wrong phone: reporting.link_invalid and ONLY redeem_failures (+version/updated_at) changes: 0 -> 1', async () => {
    const t = await redeemWorld(); const { token, row } = t.mkLink(); const before = t.snap(row);
    expect((await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: OTHER_PHONE }))).code).toBe('reporting.link_invalid');
    expect(row['redeem_failures']).toBe(1);
    expect(sameButCounter(before, row)).toBe(true);
  });

  it('the failure counter is kept although the call fails: ctx.commitOnError() on the wrong-phone path and on every other no-row path (08 A19 P-42)', async () => {
    const t = await redeemWorld(); const good = t.mkLink(); const referrer = t.mkLink({ recipient_kind: 'referrer' });
    for (const [tok, phone] of [[good.token, OTHER_PHONE], [referrer.token, PHONE], [randomBytes(16).toString('base64url'), PHONE]] as const) {
      const ctx = t.ctxFor();
      await rejection(t.redeem(ctx, { linkToken: tok, phoneE164: phone }));
      expect(ctx.commitOnError, `${tok}`).toHaveBeenCalled();
    }
    const ok = t.ctxFor(); await t.redeem(ok, { linkToken: good.token, phoneE164: PHONE });   // success needs no commitOnError, and must not require it
    expect(ok.__state.commits).toBe(0);
  });

  it('5 wrong phones lock the link: the 6th call with the CORRECT phone is reporting.link_invalid and the counter stays 5 (08 A13 D-30)', async () => {
    const t = await redeemWorld(); const { token, row } = t.mkLink();
    for (let i = 0; i < 5; i++) expect((await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: OTHER_PHONE }))).code).toBe('reporting.link_invalid');
    expect(row['redeem_failures']).toBe(5);
    expect((await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: PHONE }))).code).toBe('reporting.link_invalid');
    expect((await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: OTHER_PHONE }))).code).toBe('reporting.link_invalid');
    expect(row['redeem_failures']).toBe(5);                                            // CHECK redeem_failures BETWEEN 0 AND 5 is never violated
  });

  it('the lock is per link: another link of the same patient is unaffected', async () => {
    const t = await redeemWorld(); const a = t.mkLink(); const b = t.mkLink();
    for (let i = 0; i < 5; i++) await rejection(t.redeem(t.ctxFor(), { linkToken: a.token, phoneE164: OTHER_PHONE }));
    expect((await t.redeem(t.ctxFor(), { linkToken: b.token, phoneE164: PHONE })).reportId).toBe(R(40));
  });

  it('a link of ANOTHER tenant: reporting.link_invalid even with the right phone (DEFINER row tenant_id != ctx.tenantId), commitOnError called, nothing leaked', async () => {
    const t = await redeemWorld(); const { token, row } = t.mkLink(); const before = t.snap(row);
    const ctx = t.ctxFor('B:patient:default');
    const e = await rejection(t.redeem(ctx, { linkToken: token, phoneE164: PHONE }));
    expect(e.code).toBe('reporting.link_invalid');
    expect(ctx.commitOnError).toHaveBeenCalled();
    expect(t.snap(row)).toBe(before);
    expect(JSON.stringify(e)).not.toContain(PAT); expect(JSON.stringify(e)).not.toContain(R(40)); expect(JSON.stringify(e)).not.toContain(A);
    void B;
  });

  it('wrong phone, referrer, expired, revoked, unknown, other tenant and malformed inputs are INDISTINGUISHABLE (same name, code, message, status, field errors)', async () => {
    const t = await redeemWorld(); const good = t.mkLink();
    const attempts: Array<[any, string, unknown]> = [
      [t.ctxFor(), 'wrong phone', { linkToken: good.token, phoneE164: OTHER_PHONE }],
      [t.ctxFor(), 'referrer', { linkToken: t.mkLink({ recipient_kind: 'referrer' }).token, phoneE164: PHONE }],
      [t.ctxFor(), 'expired', { linkToken: t.mkLink({ expires_at: new Date(Date.parse(NOW) - 1).toISOString() }).token, phoneE164: PHONE }],
      [t.ctxFor(), 'revoked', { linkToken: t.mkLink({ revoked_at: NOW }).token, phoneE164: PHONE }],
      [t.ctxFor(), 'unknown', { linkToken: randomBytes(16).toString('base64url'), phoneE164: PHONE }],
      [t.ctxFor('B:patient:default'), 'other tenant', { linkToken: good.token, phoneE164: PHONE }],
      [t.ctxFor(), 'empty token', { linkToken: '', phoneE164: PHONE }],
      [t.ctxFor(), 'oversize token', { linkToken: 'x'.repeat(5000), phoneE164: PHONE }],
      [t.ctxFor(), 'non-string token', { linkToken: 42, phoneE164: PHONE }],
      [t.ctxFor(), 'malformed phone', { linkToken: good.token, phoneE164: 'not-a-phone' }],
      [t.ctxFor(), 'missing phone', { linkToken: good.token }],
      [t.ctxFor(), 'no input', undefined],
    ];
    const seen = new Map<string, string>();
    for (const [ctx, name, input] of attempts) { const e = await rejection(t.redeem(ctx, input)); expect(e.code, name).toBe('reporting.link_invalid'); seen.set(name, shape(e)); }
    expect(new Set(seen.values()).size, JSON.stringify([...seen])).toBe(1);
  });

  it('the error carries neither the token, the phone nor their hashes', async () => {
    const t = await redeemWorld(); const { token } = t.mkLink();
    const e = await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: OTHER_PHONE }));
    const blob = JSON.stringify(e, Object.getOwnPropertyNames(e)) + String(e.stack ?? '');
    for (const secret of [token, OTHER_PHONE, sha(token).toString('hex'), sha(OTHER_PHONE).toString('hex'), sha(token).toString('base64')]) expect(blob).not.toContain(secret);
  });

  it('only a patient actor may call it: user, system and partner actors are refused (auth.forbidden or reporting.link_invalid), the DEFINER is never reached, the link is untouched', async () => {
    const t = await redeemWorld(); const { token, row } = t.mkLink(); const before = t.snap(row);
    for (const key of ['A:user:default', 'A:system:default', 'A:partner:p1']) {
      const e = await rejection(t.redeem(t.ctxFor(key), { linkToken: token, phoneE164: PHONE }));
      expect(['auth.forbidden', 'reporting.link_invalid'], key).toContain(e.code);
    }
    expect(t.calls).toEqual([]);
    expect(t.snap(row)).toBe(before);
  });

  it('a failed redemption makes no write of its own (the DEFINER owns the only counter update)', async () => {
    const t = await redeemWorld(); const { token } = t.mkLink(); const writes = t.w.db.writes().length;
    await rejection(t.redeem(t.ctxFor(), { linkToken: token, phoneE164: OTHER_PHONE }));
    await rejection(t.redeem(t.ctxFor(), { linkToken: randomBytes(16).toString('base64url'), phoneE164: PHONE }));
    expect(t.w.db.writes().length).toBe(writes);
  });

  it('hostile input (SQL metacharacters, huge strings) is only ever hashed: nothing but two 32-byte buffers reaches the DEFINER', async () => {
    const t = await redeemWorld(); t.mkLink();
    for (const tok of [`' OR '1'='1`, '\u0000', '😀'.repeat(50), 'a'.repeat(100)]) await rejection(t.redeem(t.ctxFor(), { linkToken: tok, phoneE164: PHONE }));
    for (const c of t.calls) { expect(c.values).toHaveLength(2); for (const v of c.values) expect(Buffer.isBuffer(v) && (v as Buffer).length === 32).toBe(true); expect(c.text).not.toMatch(/OR '1'/); }
  });
});

describe('ReportingPort composition after C6-T37', () => {
  it('exposes getReleasedReports, openReleasedReportFile, issuePortalLink and redeemPortalLinkForApp', async () => {
    const w = await makeReportingWorld();
    for (const m of ['getReleasedReports', 'openReleasedReportFile', 'issuePortalLink', 'redeemPortalLinkForApp']) expect(typeof w.harness.impl[m], m).toBe('function');
  });
});
