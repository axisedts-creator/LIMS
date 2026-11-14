// C6-T20 ReportingPort.issuePortalLink (AC-15.2, 02-TRD §7.1, 07-SECURITY 8c, T3). 03-IC §4.5 signature.
// ASSUMED: service/portal.service.ts exports createPortalService({ env }) -> { issuePortalLink(ctx, input) } (the ReportingPort impl delegates to it);
// env.LIMS_ORIGIN_PORTAL is read at call time; ttl = ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['reportLinkTtlDays'] }) (fake answers 45);
// INSERT INTO reporting.portal_links (...) VALUES ($n, ...) with the 32-byte token hash; ctx.actor.type 'user' | 'system' only.
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });   // first import of the module manifest parses the OpenAPI spec
import { PORTAL_ORIGIN, PATIENT_MASKED, REPORT_A, REPORT_B, TENANT_A, VER_A1, idN, makePortalWorld, rejection, sha256hex } from './portal.helpers.js';

async function setup() {
  const { createPortalService } = await import('../service/portal.service.js');
  const w = makePortalWorld(); const svc: any = createPortalService({ env: { LIMS_ORIGIN_PORTAL: PORTAL_ORIGIN } } as any);
  const ctx = (type = 'user', over: Record<string, unknown> = {}) => w.baseCtx({ actor: { type, id: idN(0x7001), membershipId: idN(0x7002) }, ...over });
  return { w, svc, ctx };
}
const input = (o: Record<string, unknown> = {}) => ({ reportId: REPORT_A, channel: 'sms', recipientKind: 'patient', ...o });

describe('issuePortalLink (AC-15.2)', () => {
  it('url = {portal_origin}/r/{token}, token >= 128 bit base64url, expiresAt = now + reportLinkTtlDays; only the 32-byte hash is stored', async () => {
    const { w, svc, ctx } = await setup(); const r = await svc.issuePortalLink(ctx(), input());
    const m = /^https:\/\/portal\.lims\.invalid\/r\/([A-Za-z0-9_-]{22,})$/.exec(r.url); expect(m).not.toBeNull();
    expect(Buffer.from(m![1]!, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(r.expiresAt).toBe(new Date(Date.parse(w.now()) + 45 * 86_400_000).toISOString());
    const row = w.link(r.linkId); expect(r.linkId).toBe(row['id']);
    expect(Buffer.from(row['token_sha256']).toString('hex')).toBe(sha256hex(m![1]!)); expect(row['token_sha256'].length).toBe(32);
    expect(row).toMatchObject({ tenant_id: TENANT_A, report_id: REPORT_A, bound_version_no: 1, channel: 'sms', recipient_kind: 'patient', purpose: 'report', revoked_at: null });
    expect(Date.parse(row['expires_at'])).toBe(Date.parse(r.expiresAt));
    expect(w.allText()).not.toContain(m![1]!); expect(w.allText()).not.toContain(r.url);
  });
  it('the issued token resolves through the portal resolver as stage link', async () => {
    const { w, svc, ctx } = await setup(); const r = await svc.issuePortalLink(ctx(), input({ channel: 'patient_app' }));
    await expect(w.authenticate(`link.${r.url.split('/r/')[1]}`)).resolves.toMatchObject({ sub: r.linkId, portal_stage: 'link', portal_report_id: REPORT_A });
  });
  it('stores a masked patient snapshot (<= 60 chars, never the full name) and no destination for external callers', async () => {
    const { w, svc, ctx } = await setup(); const r = await svc.issuePortalLink(ctx('system'), input({ channel: 'print_qr' })); const row = w.link(r.linkId);
    expect(row['patient_display_snapshot'].length).toBeGreaterThan(0); expect(row['patient_display_snapshot'].length).toBeLessThanOrEqual(60);
    expect(row['patient_display_snapshot']).not.toContain('Test Patient 0001'); expect(row['destination_sha256']).toBeNull(); expect(PATIENT_MASKED.length).toBeGreaterThan(0);
  });
  it('tokens are unique across calls (CSPRNG) and the hash column is globally unique', async () => {
    const { svc, ctx } = await setup(); const urls = new Set<string>();
    for (let i = 0; i < 25; i++) urls.add((await svc.issuePortalLink(ctx(), input())).url); expect(urls.size).toBe(25);
  });
  it('unreleased report -> reporting.report_not_released; superseded versionNo -> reporting.report_superseded; other tenant -> common.not_found', async () => {
    const { w, svc, ctx } = await setup();
    w.db.store['reports']!.find((r) => r['id'] === REPORT_A)!['released_version_no'] = null; w.db.store['report_versions']!.find((v) => v['id'] === VER_A1)!['status'] = 'rendered';
    expect((await rejection(svc.issuePortalLink(ctx(), input()))).code).toBe('reporting.report_not_released');
    const w2 = makePortalWorld(); w2.amend(); const svc2: any = (await import('../service/portal.service.js')).createPortalService({ env: { LIMS_ORIGIN_PORTAL: PORTAL_ORIGIN } } as any);
    expect((await rejection(svc2.issuePortalLink(w2.baseCtx({ actor: { type: 'user', id: idN(0x7001) } }), input({ versionNo: 1 })))).code).toBe('reporting.report_superseded');
    await expect(svc2.issuePortalLink(w2.baseCtx({ actor: { type: 'user', id: idN(0x7001) } }), input({ versionNo: 2 }))).resolves.toMatchObject({ linkId: expect.any(String) });
    expect((await rejection(svc2.issuePortalLink(w2.baseCtx({ actor: { type: 'user', id: idN(0x7001) } }), input({ reportId: REPORT_B })))).code).toBe('common.not_found');
    expect(w2.db.store['portal_links']!.length).toBe(1);
  });
  it('08 A2.1 / 07-SECURITY 8c: partner, portal, patient and device actors -> auth.forbidden, nothing stored', async () => {
    const { w, svc, ctx } = await setup();
    for (const t of ['partner', 'portal', 'patient', 'device']) expect((await rejection(svc.issuePortalLink(ctx(t), input()))).code, t).toBe('auth.forbidden');
    expect(w.db.store['portal_links']).toEqual([]);
  });
  it('the URL is not logged and no event / delivery is created by issuing', async () => {
    const { w, svc, ctx } = await setup(); const r = await svc.issuePortalLink(ctx(), input());
    expect(w.logs.join('')).not.toContain(r.url.split('/r/')[1]); expect(w.sent).toEqual([]); expect(w.forbiddenCalls).toEqual([]);
  });
  it('invalid channel / recipientKind never reach SQL (validation_failed or a CHECK-safe refusal)', async () => {
    const { w, svc, ctx } = await setup();
    for (const bad of [{ channel: 'fax' }, { recipientKind: 'admin' }, { reportId: 'not-a-uuid' }]) expect((await rejection(svc.issuePortalLink(ctx(), input(bad)))).code).toMatch(/^(common\.validation_failed|common\.not_found)$/);
    expect(w.db.store['portal_links']).toEqual([]);
  });
});
