// C6-T22 — R14 POST /report-versions/{id}/qr-token/revoke (revokeReportQrToken), R15 GET /reports/{id}/portal-links (listPortalLinks), R16 POST /portal-links/{id}/revoke (revokePortalLink).
// ACs: AC-10.3 (a revoked QR token is indistinguishable from an unknown one), AC-10.5 (no token/hash ever returned); 07-SECURITY test 1 (cross-tenant probe per operation), test 9 (log scan),
// 02-TRD §6.3 R14-R16, §9 audit (R14/R16 -> action report.token_revoke, entity qr_token / portal_link), 05-SCHEMA qr_tokens/portal_links mutable columns (revoked_at, revoked_by, revoke_reason_code[, text]).
// ASSUMED handler contract (like R6/N5): handler(req, ctx), ctx = { tenantId, actor {type 'user', id}, tx, now(), log, audit.access(entry) }, req = { params, body }. Permission
// (reporting.token.revoke / reporting.delivery.read) and Idempotency-Key are enforced by the core pipeline; the handler fails closed without ctx (auth.unauthenticated) and for a non-user
// actor (auth.forbidden). Errors: unknown / other-tenant id -> common.not_found; bad body -> common.validation_failed; revoke is idempotent: an already revoked token/link answers 200 with the
// ORIGINAL revoked_at and is not rewritten (the OpenAPI lists no conflict code and the DB trigger forbids changing revoked_*). Reason codes are validated against token_revoke_reasons;
// `other` needs reason_text. Revoke writes: UPDATE ... SET revoked_at, revoked_by, revoke_reason_code, revoke_reason_text ... WHERE tenant_id AND id AND revoked_at IS NULL.
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { NOW, PHONE, REPORT_A, REPORT_A2, REPORT_B, TENANT_A, TENANT_B, VER_A1, VER_B1, idN, rejection, sha256buf } from './portal.helpers.js';
import { USER, USER2, failureBytes, makeVerifyWorld, type VerifyWorld } from './verify.helpers.js';
import { issueToken } from '../domain/tokens.js';

const R14 = 'revokeReportQrToken'; const R15 = 'listPortalLinks'; const R16 = 'revokePortalLink';
const codeOf = async (p: Promise<unknown>) => (await rejection(p)).code;
const revoke14 = (w: VerifyWorld, versionId: string, body: any = { reason_code: 'issued_in_error' }, ctx: any = w.staffCtx()) => w.run(R14, ctx, { params: { report_version_id: versionId }, body });
const revoke16 = (w: VerifyWorld, linkId: string, body: any = { reason_code: 'wrong_recipient' }, ctx: any = w.staffCtx()) => w.run(R16, ctx, { params: { link_id: linkId }, body });
const list15 = (w: VerifyWorld, reportId: string, ctx: any = w.staffCtx()) => w.run(R15, ctx, { params: { report_id: reportId } });
const unknownId = idN(0xdead);

describe('contract', () => {
  const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
  it('R14 / R16: reporting.token.revoke, Idempotency-Key required, body { reason_code, reason_text? }, 200 { revoked_at }', () => {
    for (const [p, id] of [['/v1/reporting/report-versions/{report_version_id}/qr-token/revoke', R14], ['/v1/reporting/portal-links/{link_id}/revoke', R16]] as const) {
      const op = spec.paths[p].post; expect(op.operationId).toBe(id); expect(op['x-permission']).toBe('reporting.token.revoke'); expect(op['x-idempotency']).toBe('required');
      expect(op.requestBody.content['application/json'].schema.required).toEqual(['reason_code']); expect(op.requestBody.content['application/json'].schema.properties.reason_code['x-coded-set']).toBe('reporting.token_revoke_reasons');
    }
  });
  it('R15: reporting.delivery.read, 200 { data[] } items carry no token / url / hash', () => {
    const op = spec.paths['/v1/reporting/reports/{report_id}/portal-links'].get; expect(op.operationId).toBe(R15); expect(op['x-permission']).toBe('reporting.delivery.read');
    const item = op.responses['200'].content['application/json'].schema.properties.data.items; expect(Object.keys(item.properties).sort()).toEqual(['channel', 'destination_masked', 'expires_at', 'id', 'last_used_at', 'recipient_kind', 'revoked_at', 'use_count']);
  });
  it('all three are implemented (not the 501 stub) and fail closed without a request context, echoing no input', async () => {
    const planted = 'PLANTED-REASON-7c1e'; const h = (await import('../index.js')).manifest.handlers; const w = makeVerifyWorld();
    for (const [op, params] of [[R14, { report_version_id: VER_A1 }], [R15, { report_id: REPORT_A }], [R16, { link_id: unknownId }]] as const) {
      const e = await rejection(h[op]!({ params, query: {}, headers: {}, body: { reason_code: planted, reason_text: planted } } as any, { operationId: op, clientIp: '203.0.113.9', log: w.log } as any));
      expect(e?.code, op).toBe('auth.unauthenticated'); expect(failureBytes(e)).not.toContain(planted);
    }
  });
  it('a portal (or other non-user) actor is refused: auth.forbidden, nothing changed', async () => {
    const w = makeVerifyWorld(); const l = w.mkLink(); const portal = { type: 'portal', id: l.row['id'] };
    expect(await codeOf(revoke14(w, VER_A1, undefined, w.staffCtx({ actor: portal })))).toBe('auth.forbidden');
    expect(await codeOf(revoke16(w, l.row['id'], undefined, w.staffCtx({ actor: portal })))).toBe('auth.forbidden');
    expect(await codeOf(list15(w, REPORT_A, w.staffCtx({ actor: portal })))).toBe('auth.forbidden');
    expect(w.qrRow(VER_A1)['revoked_at']).toBeNull(); expect(w.linkRow(l.row['id'])['revoked_at']).toBeNull();
  });
});

describe('R14 revokeReportQrToken (AC-10.3, AC-10.5)', () => {
  it('200 { revoked_at } = now; the row gets revoked_at, revoked_by = the user, reason code and text', async () => {
    const w = makeVerifyWorld();
    const r = await revoke14(w, VER_A1, { reason_code: 'security_concern', reason_text: 'synthetic reason' });
    expect(r.status).toBe(200); expect(r.body).toEqual({ revoked_at: NOW });
    expect(w.qrRow(VER_A1)).toMatchObject({ revoked_by: USER, revoke_reason_code: 'security_concern', revoke_reason_text: 'synthetic reason' });
    expect(new Date(w.qrRow(VER_A1)['revoked_at']).toISOString()).toBe(NOW);
  });
  it('after the revoke, Q1 answers the same 404 as for an unknown token, byte for byte (AC-10.3 through the real R14)', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1);
    expect((await w.q1(t)).status).toBe(200);
    await revoke14(w, VER_A1);
    const e = await rejection(w.q1(t)); expect(e).toMatchObject({ code: 'reporting.verify_not_found', statusCode: 404 });
    expect(failureBytes(e)).toBe(failureBytes(await rejection(w.q1(issueToken('qr').token))));
  });
  it('revoking one version does not touch the other versions or other reports', async () => {
    const w = makeVerifyWorld(); w.amend(); await revoke14(w, VER_A1);
    expect(w.db.store['qr_tokens']!.filter((q) => q['revoked_at'] != null).map((q) => q['report_version_id'])).toEqual([VER_A1]);
  });
  it('writes the access log: action report.token_revoke, entity qr_token + its id, outcome allowed; no token, hash or reason text in it', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); await revoke14(w, VER_A1, { reason_code: 'other', reason_text: 'PLANTED-FREE-TEXT-91' });
    expect(w.audit).toHaveLength(1); expect(w.audit[0]).toMatchObject({ action: 'report.token_revoke', entityType: 'qr_token', entityId: w.qrRow(VER_A1)['id'], outcome: 'allowed' });
    expect(JSON.stringify(w.audit)).not.toContain(t); expect(JSON.stringify(w.audit)).not.toContain('PLANTED-FREE-TEXT-91'); expect(w.allText().replace(/PLANTED-FREE-TEXT-91/g, '')).not.toContain(t);
  });
  it('idempotent: a second revoke is 200 with the ORIGINAL revoked_at / reason / actor, and the row is not rewritten', async () => {
    const w = makeVerifyWorld(); await revoke14(w, VER_A1, { reason_code: 'issued_in_error' }); w.advance(3600_000);
    const r = await revoke14(w, VER_A1, { reason_code: 'security_concern' }, w.staffCtx({ actor: { type: 'user', id: USER2 } }));
    expect(r.status).toBe(200); expect(r.body).toEqual({ revoked_at: NOW }); expect(w.qrRow(VER_A1)).toMatchObject({ revoked_by: USER, revoke_reason_code: 'issued_in_error' });
  });
  it('two concurrent revokes: both 200 with the same revoked_at, one winner recorded', async () => {
    const w = makeVerifyWorld();
    const [a, b] = await Promise.all([revoke14(w, VER_A1, undefined, w.staffCtx()), revoke14(w, VER_A1, { reason_code: 'security_concern' }, w.staffCtx({ actor: { type: 'user', id: USER2 } }))]);
    expect([a.status, b.status]).toEqual([200, 200]); expect(a.body.revoked_at).toBe(b.body.revoked_at); expect([USER, USER2]).toContain(w.qrRow(VER_A1)['revoked_by']);
    expect(w.qrRow(VER_A1)['revoke_reason_code']).toBe(w.qrRow(VER_A1)['revoked_by'] === USER ? 'issued_in_error' : 'security_concern');
  });
  it('unknown version id -> common.not_found; a version without a qr token -> common.not_found; nothing written', async () => {
    const w = makeVerifyWorld(); expect(await codeOf(revoke14(w, unknownId))).toBe('common.not_found');
    w.db.store['qr_tokens']!.splice(0, w.db.store['qr_tokens']!.length); expect(await codeOf(revoke14(w, VER_A1))).toBe('common.not_found'); expect(w.db.writes()).toEqual([]);
  });
  it('cross-tenant (07-SECURITY 1): tenant A cannot revoke tenant B\'s token and gets the SAME not_found as for an unknown id; B is unchanged and B\'s token still verifies', async () => {
    const w = makeVerifyWorld(); const tB = w.qrTokenFor(VER_B1);
    const e = await rejection(revoke14(w, VER_B1)); expect(e.code).toBe('common.not_found'); expect(failureBytes(e)).toBe(failureBytes(await rejection(revoke14(w, unknownId))));
    expect(w.qrRow(VER_B1)['revoked_at']).toBeNull(); expect((await w.q1(tB)).status).toBe(200);
    const eB = await rejection(revoke14(w, VER_A1, undefined, w.staffCtx({ tenantId: TENANT_B }))); expect(eB.code).toBe('common.not_found'); expect(w.qrRow(VER_A1)['revoked_at']).toBeNull();
  });
  it('every statement on the qr table names tenant_id (defence in depth next to RLS)', async () => {
    const w = makeVerifyWorld(); expect((await revoke14(w, VER_A1)).status).toBe(200);
    const qs = w.db.stmts.filter((x) => /reporting\.qr_tokens/i.test(x.text)); expect(qs.length).toBeGreaterThan(0);
    for (const s of qs) { expect(s.text, s.text).toMatch(/\btenant_id\b/i); expect(s.values).toContain(TENANT_A); }
  });
  describe('validation (common.validation_failed, nothing written)', () => {
    it.each([
      ['unknown reason code', { reason_code: 'because' }], ['missing reason_code', {}], ['empty reason_code', { reason_code: '' }], ['non-string reason_code', { reason_code: 5 }],
      ['other without text', { reason_code: 'other' }], ['other with blank text', { reason_code: 'other', reason_text: '   ' }], ['text > 500 chars', { reason_code: 'issued_in_error', reason_text: 'x'.repeat(501) }],
      ['non-string text', { reason_code: 'issued_in_error', reason_text: 7 }], ['extra property', { reason_code: 'issued_in_error', extra: 1 }], ['no body', null], ['array body', []], ['string body', 'issued_in_error'],
    ])('R14 %s', async (_n, body) => {
      const w = makeVerifyWorld(); expect(await codeOf(revoke14(w, VER_A1, body))).toBe('common.validation_failed');
      expect(w.qrRow(VER_A1)['revoked_at']).toBeNull(); expect(w.db.writes()).toEqual([]);
    });
    it('a 500-char reason_text is accepted; "other" with text is accepted', async () => {
      const w = makeVerifyWorld(); expect((await revoke14(w, VER_A1, { reason_code: 'other', reason_text: 'x'.repeat(500) })).status).toBe(200);
    });
    it('SQL in reason fields is stored/handled as data (parameterised): the table still works afterwards', async () => {
      const w = makeVerifyWorld(); await revoke14(w, VER_A1, { reason_code: 'other', reason_text: "x'); DROP TABLE reporting.qr_tokens;--" });
      expect(w.qrRow(VER_A1)['revoke_reason_text']).toBe("x'); DROP TABLE reporting.qr_tokens;--"); for (const s of w.db.stmts) expect(s.text).not.toContain('DROP TABLE');
    });
  });
});

describe('R15 listPortalLinks', () => {
  const seed = (w: VerifyWorld) => {
    const live = w.mkLink({ channel: 'sms', recipient_kind: 'patient', destination_masked: '*******0010', use_count: 3, last_used_at: '2026-11-05T04:00:00.000Z' });
    const revoked = w.mkLink({ channel: 'email', recipient_kind: 'referrer', destination_masked: 'p***@example.com', revoked_at: '2026-11-05T05:00:00.000Z', revoked_by: USER, revoke_reason_code: 'issued_in_error' });
    const qrOnly = w.mkLink({ channel: 'print_qr', recipient_kind: 'patient' });
    const other = w.mkLink({ report_id: REPORT_A2 });
    return { live, revoked, qrOnly, other };
  };
  it('200 { data[] } with the links of THAT report only: id, channel, recipient_kind, destination_masked, expires_at, revoked_at, last_used_at, use_count', async () => {
    const w = makeVerifyWorld(); const s = seed(w); const r = await list15(w, REPORT_A);
    expect(r.status).toBe(200); expect(Object.keys(r.body)).toEqual(['data']); expect(r.body.data.map((x: any) => x.id).sort()).toEqual([s.live.row['id'], s.revoked.row['id'], s.qrOnly.row['id']].sort());
    const live = r.body.data.find((x: any) => x.id === s.live.row['id']);
    expect(live).toEqual({ id: s.live.row['id'], channel: 'sms', recipient_kind: 'patient', destination_masked: '*******0010', expires_at: s.live.row['expires_at'], last_used_at: '2026-11-05T04:00:00.000Z', use_count: 3 });
    const rev = r.body.data.find((x: any) => x.id === s.revoked.row['id']); expect(rev).toMatchObject({ revoked_at: '2026-11-05T05:00:00.000Z', channel: 'email', recipient_kind: 'referrer' });
  });
  it('unset optional fields are omitted (not null): destination_masked / revoked_at / last_used_at', async () => {
    const w = makeVerifyWorld(); const s = seed(w); const it = (await list15(w, REPORT_A)).body.data.find((x: any) => x.id === s.qrOnly.row['id']);
    for (const k of ['destination_masked', 'revoked_at', 'last_used_at']) expect(Object.hasOwn(it, k), k).toBe(false);
    expect(it.use_count).toBe(0);
  });
  it('no token, no URL, no hash, no full destination, no patient name in the response (AC-10.5, REQ-SEC-093)', async () => {
    const w = makeVerifyWorld(); const s = seed(w); const res = await list15(w, REPORT_A); const text = JSON.stringify(res);
    expect(res.status).toBe(200); expect(res.body.data).toHaveLength(3);
    for (const l of [s.live, s.revoked, s.qrOnly]) { expect(text).not.toContain(l.token); expect(text).not.toContain(Buffer.from(l.row['token_sha256']).toString('hex')); }
    expect(text).not.toMatch(/token|sha256|https?:|\/r\/|patient_display|T\*\*\* P\*\*\*/i); expect(text).not.toContain(PHONE);
  });
  it('a report with no links -> 200 { data: [] }', async () => {
    const w = makeVerifyWorld(); expect((await list15(w, REPORT_A)).body).toEqual({ data: [] });
  });
  it('at most 200 items (OpenAPI maxItems)', async () => {
    const w = makeVerifyWorld(); for (let i = 0; i < 205; i++) w.mkLink({ destination_masked: '*******0010' });
    expect((await list15(w, REPORT_A)).body.data.length).toBeLessThanOrEqual(200);
  });
  it('unknown report -> common.not_found; cross-tenant (A asks for B\'s report, B asks for A\'s) -> the SAME not_found and none of the other tenant\'s links', async () => {
    const w = makeVerifyWorld(); seed(w); w.mkLink({ tenant_id: TENANT_B, report_id: REPORT_B });
    const ref = failureBytes(await rejection(list15(w, unknownId)));
    expect(failureBytes(await rejection(list15(w, REPORT_B)))).toBe(ref); expect(failureBytes(await rejection(list15(w, REPORT_A, w.staffCtx({ tenantId: TENANT_B }))))).toBe(ref);
    expect(JSON.stringify((await list15(w, REPORT_A)).body)).not.toContain(w.db.store['portal_links']!.find((l) => l['tenant_id'] === TENANT_B)!['id']);
  });
  it('read-only (no write, no audit row needed beyond the pipeline) and every statement names tenant_id', async () => {
    const w = makeVerifyWorld(); seed(w); const n = w.db.stmts.length; expect((await list15(w, REPORT_A)).status).toBe(200);
    const mine = w.db.stmts.slice(n); expect(mine.length).toBeGreaterThan(0); expect(mine.filter((s) => s.verb !== 'select')).toEqual([]);
    for (const s of mine) { expect(s.text, s.text).toMatch(/\btenant_id\b/i); expect(s.values).toContain(TENANT_A); }
  });
});

describe('R16 revokePortalLink', () => {
  it('200 { revoked_at } = now; the link gets revoked_at, revoked_by, revoke_reason_code; other links untouched', async () => {
    const w = makeVerifyWorld(); const l = w.mkLink(); const o = w.mkLink(); const r = await revoke16(w, l.row['id'], { reason_code: 'wrong_recipient', reason_text: 'synthetic' });
    expect(r.status).toBe(200); expect(r.body).toEqual({ revoked_at: NOW });
    expect(w.linkRow(l.row['id'])).toMatchObject({ revoked_by: USER, revoke_reason_code: 'wrong_recipient' }); expect(new Date(w.linkRow(l.row['id'])['revoked_at']).toISOString()).toBe(NOW);
    expect(w.linkRow(o.row['id'])['revoked_at']).toBeNull();
  });
  it('after the revoke the link credential is rejected as link_invalid (identical to an unknown link) and so is a live session of it', async () => {
    const w = makeVerifyWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); expect((await w.authenticate(s.cred)).tenant_id).toBe(TENANT_A);
    await revoke16(w, l.row['id']);
    const e = await rejection(w.authenticate(l.cred)); expect(e.code).toBe('reporting.link_invalid');
    expect(failureBytes(e)).toBe(failureBytes(await rejection(w.authenticate(`link.${issueToken('link').token}`))));
    expect((await rejection(w.authenticate(s.cred))).code).toBe('reporting.link_invalid');
  });
  it('precondition (passes today, guards the test above): the existing resolver already rejects a link/session once portal_links.revoked_at is set', async () => {
    const w = makeVerifyWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); w.linkRow(l.row['id'])['revoked_at'] = NOW;
    expect((await rejection(w.authenticate(l.cred))).code).toBe('reporting.link_invalid'); expect((await rejection(w.authenticate(s.cred))).code).toBe('reporting.link_invalid');
  });
  it('an expired link and a dues-purpose link can be revoked too', async () => {
    const w = makeVerifyWorld(); const e = w.mkLink({ expires_at: new Date(Date.parse(NOW) - 1000).toISOString() }); const d = w.mkLink({ purpose: 'dues' });
    expect((await revoke16(w, e.row['id'])).status).toBe(200); expect((await revoke16(w, d.row['id'])).status).toBe(200);
  });
  it('writes the access log: action report.token_revoke, entity portal_link + link id, outcome allowed; no token in it', async () => {
    const w = makeVerifyWorld(); const l = w.mkLink(); await revoke16(w, l.row['id']);
    expect(w.audit).toHaveLength(1); expect(w.audit[0]).toMatchObject({ action: 'report.token_revoke', entityType: 'portal_link', entityId: l.row['id'], outcome: 'allowed' });
    expect(w.allText()).not.toContain(l.token);
  });
  it('idempotent: revoking a revoked link is 200 with the original revoked_at; concurrent revokes both 200', async () => {
    const w = makeVerifyWorld(); const l = w.mkLink(); await revoke16(w, l.row['id'], { reason_code: 'issued_in_error' }); w.advance(60_000);
    const r = await revoke16(w, l.row['id'], { reason_code: 'security_concern' }, w.staffCtx({ actor: { type: 'user', id: USER2 } }));
    expect(r.body).toEqual({ revoked_at: NOW }); expect(w.linkRow(l.row['id'])).toMatchObject({ revoked_by: USER, revoke_reason_code: 'issued_in_error' });
    const m = w.mkLink(); const [a, b] = await Promise.all([revoke16(w, m.row['id']), revoke16(w, m.row['id'], undefined, w.staffCtx({ actor: { type: 'user', id: USER2 } }))]);
    expect([a.status, b.status]).toEqual([200, 200]); expect(a.body.revoked_at).toBe(b.body.revoked_at);
  });
  it('unknown link -> common.not_found; cross-tenant link -> the SAME not_found, tenant B\'s link unchanged and still usable', async () => {
    const w = makeVerifyWorld(); const lb = w.mkLink({ tenant_id: TENANT_B, report_id: REPORT_B });
    const ref = failureBytes(await rejection(revoke16(w, unknownId)));
    const e = await rejection(revoke16(w, lb.row['id'])); expect(e.code).toBe('common.not_found'); expect(failureBytes(e)).toBe(ref);
    expect(w.linkRow(lb.row['id'])['revoked_at']).toBeNull(); expect((await w.authenticate(lb.cred)).tenant_id).toBe(TENANT_B);
  });
  it('every statement on portal_links names tenant_id; a revoke never rewrites token_sha256 / expires_at / bound_version_no', async () => {
    const w = makeVerifyWorld(); const l = w.mkLink(); const keep = JSON.stringify([l.row['token_sha256'], l.row['expires_at'], l.row['bound_version_no'], l.row['report_id']]);
    expect((await revoke16(w, l.row['id'])).status).toBe(200);
    const ls = w.db.stmts.filter((x) => /reporting\.portal_links/i.test(x.text)); expect(ls.length).toBeGreaterThan(0);
    for (const s of ls) expect(s.text, s.text).toMatch(/\btenant_id\b/i);
    const now = w.linkRow(l.row['id']); expect(JSON.stringify([now['token_sha256'], now['expires_at'], now['bound_version_no'], now['report_id']])).toBe(keep);
  });
  describe('validation (common.validation_failed, nothing written)', () => {
    it.each([
      ['unknown reason code', { reason_code: 'because' }], ['missing reason_code', {}], ['other without text', { reason_code: 'other' }], ['text > 500', { reason_code: 'wrong_recipient', reason_text: 'x'.repeat(501) }],
      ['extra property', { reason_code: 'wrong_recipient', revoked_at: NOW }], ['no body', null],
    ])('R16 %s', async (_n, body) => {
      const w = makeVerifyWorld(); const l = w.mkLink(); const n = w.db.writes().length;
      expect(await codeOf(revoke16(w, l.row['id'], body))).toBe('common.validation_failed'); expect(w.linkRow(l.row['id'])['revoked_at']).toBeNull(); expect(w.db.writes().length).toBe(n);
    });
  });
});

describe('logs', () => {
  it('no plaintext token, hash, reason text or phone in any log line across R14-R16 and Q1 (07-SECURITY 9)', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); const l = w.mkLink({ destination_masked: '*******0010' });
    await list15(w, REPORT_A); await revoke16(w, l.row['id'], { reason_code: 'other', reason_text: 'PLANTED-REASON-33' }); await revoke14(w, VER_A1, { reason_code: 'other', reason_text: 'PLANTED-REASON-34' }); await rejection(w.q1(t));
    const text = w.logs.join('\n');
    for (const s of [t, l.token, sha256buf(t).toString('hex'), Buffer.from(l.row['token_sha256']).toString('hex'), 'PLANTED-REASON-33', 'PLANTED-REASON-34', PHONE]) expect(text).not.toContain(s);
  });
});
