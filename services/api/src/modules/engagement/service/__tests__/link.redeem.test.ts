// C16.T-L2 — E14 redeemLinkCode (patient): DEFINER redemption, limits, failure counter, reactivation (06-PLAN row T-L2; 02-TRD §4.3 constants, §4.3.2, §4.3.5, §5 E14, §9.4 access log `app_link.redeem`, §13 metric;
// 05-SCHEMA §4 guard, §6.1 app.engagement_redeem_link_code(bytea), §6.6 tests 2 + 6; 01-PRD US-EN-03.2-5, 03.8, US-EN-04.4, US-EN-06.7; 07-SECURITY E14/E15 row, REQ-SEC-074, probe P-L9; 08 A2.4/A5.5, A19 P-42.)
// done_when: backfill from views + getReleasedReports (worker side: services/worker/src/jobs/engagement/__tests__/backfill_link.test.ts). This file: wrong phone -> invalid; reuse -> invalid; same account -> 200; failure counter persists
// after each 422 (commitOnError) and -> 429 after 5; limit 409 rolls the redemption back (code still issued); self code for an account with a self link -> other; suspended link reactivated by the DEFINER; sex_snapshot copied.
// Fails now: handlers/index.ts maps redeemLinkCode to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec fixes behaviour, not names; same convention as link.handlers.test.ts):
//   handlers.redeemLinkCode({params, query, headers, body:{code}}, ctx) -> {status:201|200, body: Profile, headers:{cache-control:'no-store'}}; errors are thrown LimsErrors (code).
//   ctx = world.patientCtx(account): actor {type:'patient', id:<user id>}, claims {sub, tenant_id, membership_id, actor_type:'patient'}. The account is found through ctx.tx (accounts row with that membership_id / user_id;
//   the world's RLS shows a patient only its own account + links). IdentityPort.assertRole(ctx, {permission:'engagement.link.redeem'}) runs before any query.
//   The code is redeemed ONLY through `SELECT * FROM app.engagement_redeem_link_code($1::bytea)` with the 32-byte HMAC Buffer (the world refuses a text/hex parameter with 42883 and gives patient actors no access to link_codes).
//   Failure counter: engagement.number_counters key `linkfail:<account_id>:<yyyymmddhh>` (the hour bucket is the writer's choice of timezone; the test only needs it to change within 61 minutes), upsert `last_value + 1`.
//   Jobs: SELECT app.enqueue_job('engagement.backfill_link', '{"link_id": ..}'::jsonb, 'backfill:<link_id>'). Access log: ctx.audit.access({action:'app_link.redeem', entityType:'app_link', entityId:<link id>}).
//   Metric: ctx.metrics.inc('lims_engagement_link_events_total', {method:'link_code', outcome:'redeemed' | 'invalid' | 'limit'}).
//   SQL the service writes must stay inside the world's grammar (__tests__/link.world.ts header).
// NOT pinned (spec conflict, see .orchestra/notes/T-L2-tests.md): US-EN-03 AC4 "A1 redeems an already-REDEEMED code again -> 200" vs the DEFINER's `status = 'issued'` filter (05-SCHEMA §6.1).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ID, TENANT_B, linkCodeHmac, makeLinkWorld, phoneHmac, type LinkWorld } from '../../__tests__/link.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const CODE = 'ABCDE-FGH23', PHONE = '+99001000001', OTHER_PHONE = '+99001000002', THIRD_PHONE = '+99001000003';
const P = ID(0x700), P2 = ID(0x701), P3 = ID(0x702), P4 = ID(0x703);
const INVALID = 'engagement.link_code_invalid', LIMIT = 'engagement.link_limit_reached';
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };
const shape = (e: any) => ({ code: e.code, statusCode: e.statusCode, detail: e.detail, errors: e.errors });
const hour = 3_600_000;

interface Fx { w: LinkWorld; acct: Record<string, any>; code: Record<string, any>; ctx: (a?: Record<string, any>) => any; redeem: (code?: unknown, a?: Record<string, any>) => Promise<any>; links: (accountId?: string) => any[] }
/** One tenant-A world: account A1 (phone PHONE) and an issued code for patient P bound to PHONE (relationship self, sex female, record phone hmac set). */
function setup(o: { maxProfiles?: number; maxAccountsPerPatient?: number; code?: Record<string, any> } = {}): Fx {
  const w = makeLinkWorld({ maxProfiles: o.maxProfiles, maxAccountsPerPatient: o.maxAccountsPerPatient });
  const acct = w.seedAccount(PHONE);
  for (const p of [P, P2, P3, P4]) w.setDemographics(p, {});
  const code = w.seedCode(P, { plain: CODE, boundPhone: PHONE, ...o.code });
  const ctx = (a: Record<string, any> = acct) => w.patientCtx(a);
  const redeem = (c: unknown = CODE, a: Record<string, any> = acct) => w.inTx(() => (handlers as any).redeemLinkCode({ params: {}, query: {}, headers: {}, body: { code: c } }, ctx(a)));
  return { w, acct, code, ctx, redeem, links: (id = acct['id']) => w.t['account_patient_links']!.filter((l) => l['account_id'] === id) };
}
const counters = (w: LinkWorld) => w.t['number_counters']!.filter((c) => String(c['counter_key']).startsWith('linkfail:'));
const redeemMetric = (w: LinkWorld, outcome: string) => w.metricCalls.filter((m) => m.name === 'lims_engagement_link_events_total' && m.labels['outcome'] === outcome && m.labels['method'] === 'link_code');

describe('contract sanity (the spec is the source of the permission and idempotency)', () => {
  it('E14: engagement.link.redeem, Idempotency-Key required, 201/200 Profile, 422 + 409 + 429', () => {
    expect(opOf('redeemLinkCode')).toMatchObject({ 'x-permission': 'engagement.link.redeem', 'x-idempotency': 'required' });
    expect(Object.keys(opOf('redeemLinkCode').responses)).toEqual(expect.arrayContaining(['200', '201', '409', '422', '429']));
  });
});

describe('test-world guard: the DB rules the redeem tests rely on (05-SCHEMA §4, §5, §6.1; probe P-L9)', () => {
  it('a patient UPDATE of a suspended link to active / visible_from / method is refused (immutable_row); relationship and revoke are allowed', async () => {
    const f = setup(); const l = f.w.seedLink(f.acct['id'], P, { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: f.w.now(), visible_from: '2026-02-01T00:00:00.000Z' }); const c = f.ctx();
    await expect(c.tx.query(`UPDATE engagement.account_patient_links SET status = 'active', suspend_reason = NULL, suspended_at = NULL WHERE tenant_id = $1 AND id = $2`, [f.w.tenantId, l['id']])).rejects.toMatchObject({ message: expect.stringContaining('immutable_row') });
    await expect(c.tx.query(`UPDATE engagement.account_patient_links SET visible_from = NULL WHERE tenant_id = $1 AND id = $2`, [f.w.tenantId, l['id']])).rejects.toMatchObject({ message: expect.stringContaining('immutable_row') });
    await expect(c.tx.query(`UPDATE engagement.account_patient_links SET relationship = 'other' WHERE tenant_id = $1 AND id = $2`, [f.w.tenantId, l['id']])).resolves.toMatchObject({ rowCount: 1 });
  });
  it('a patient has no access to link_codes (only the DEFINER reads it); the DEFINER takes bytea only', async () => {
    const f = setup(); const c = f.ctx();
    await expect(c.tx.query('SELECT * FROM engagement.link_codes WHERE tenant_id = $1', [f.w.tenantId])).rejects.toMatchObject({ code: '42501' });
    await expect(c.tx.query('SELECT * FROM app.engagement_redeem_link_code($1)', ['ab'.repeat(32)])).rejects.toMatchObject({ code: '42883' });
  });
  it('the DEFINER itself: redeems for the bound phone only, reactivates a suspended link, refuses an expired / used code', async () => {
    const f = setup(); const hm = linkCodeHmac(f.w.tenantId, CODE);
    const other = f.w.seedAccount(OTHER_PHONE);
    expect((await f.w.patientCtx(other).tx.query('SELECT * FROM app.engagement_redeem_link_code($1::bytea)', [hm])).rows).toHaveLength(0);
    expect(f.code['status']).toBe('issued');
    const r = await f.ctx().tx.query('SELECT * FROM app.engagement_redeem_link_code($1::bytea)', [hm]);
    expect(r.rows).toHaveLength(1); expect(f.code['status']).toBe('redeemed');
    expect((await f.ctx().tx.query('SELECT * FROM app.engagement_redeem_link_code($1::bytea)', [hm])).rows).toHaveLength(0);
  });
});

describe('US-EN-03.2 redeem for the bound phone -> 201 Profile + link + backfill', () => {
  it('201 {profile}, Cache-Control: no-store; link {method link_code, relationship from the code, active, visible_from NULL}; code redeemed; backfill_link enqueued; access log; metric', async () => {
    const f = setup(); const r = await f.redeem();
    expect(r.status).toBe(201);
    expect(schemaErrors('Profile', r.body)).toEqual([]);
    expect(r.headers?.['cache-control'] ?? r.headers?.['Cache-Control']).toBe('no-store');
    const [l] = f.links(); expect(f.links()).toHaveLength(1);
    expect(l).toMatchObject({ tenant_id: f.w.tenantId, account_id: f.acct['id'], patient_id: P, method: 'link_code', relationship: 'self', status: 'active', visible_from: null, link_code_id: f.code['id'], consent_id: f.code['consent_id'], display_name: 'Synthetic Patient' });
    expect(r.body).toMatchObject({ profile_id: l['id'], display_name: 'Synthetic Patient', relationship: 'self', method: 'link_code', status: 'active' });
    expect(r.body).not.toHaveProperty('history_from'); // visible_from NULL = full history: nothing to show
    expect(f.code).toMatchObject({ status: 'redeemed', redeemed_account_id: f.acct['id'] }); expect(f.code['redeemed_at']).toBeTruthy();
    const jobs = f.w.jobs('engagement.backfill_link'); expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ link_id: l['id'] }); expect(jobs[0]!.jobKey).toBe(`backfill:${l['id']}`);
    expect(f.w.audit.filter((a) => a['action'] === 'app_link.redeem')).toEqual([expect.objectContaining({ entityType: 'app_link', entityId: l['id'] })]);
    expect(redeemMetric(f.w, 'redeemed')).toHaveLength(1);
    expect(f.w.commit.calls).toBe(0); expect(counters(f.w)).toHaveLength(0); // a success writes no failure counter
  });

  it('the DEFINER gets the 32-byte code_hmac = HMAC(link key, tenant_id:normalised code) as a Buffer (08 A2.4/A5.5), never text or hex; exactly one call', async () => {
    const f = setup(); await f.redeem();
    expect(f.w.definerCalls).toHaveLength(1);
    const arg = f.w.definerCalls[0]!.values[0]; expect(Buffer.isBuffer(arg) || arg instanceof Uint8Array).toBe(true);
    expect(Buffer.from(arg as Uint8Array).equals(linkCodeHmac(f.w.tenantId, CODE))).toBe(true);
    expect(f.w.stmts.some((s) => /decode\s*\(/i.test(s.text))).toBe(false);
  });

  it('normalises the typed code: lower case, spaces / dashes, O -> 0, I and L -> 1', async () => {
    const f = setup({ code: { plain: 'ABCDEFGH01' } });
    expect((await f.redeem('abcde fghOl')).status).toBe(201);
  });

  it('copies the code onto the link: relationship child, sex_snapshot, record_phone_hmac_at_link (bytea), display name snapshot, consent', async () => {
    const rec = phoneHmac(TENANT_B, '+99001000099');
    const f = setup({ code: { relationship: 'child', sex_snapshot: 'male', display_name_snapshot: 'Milan Synthetic', record_phone_hmac: rec } }); const r = await f.redeem();
    expect(r.status).toBe(201);
    const [l] = f.links();
    expect(l).toMatchObject({ relationship: 'child', sex_snapshot: 'male', display_name: 'Milan Synthetic', consent_id: f.code['consent_id'] });
    expect(Buffer.isBuffer(l['record_phone_hmac_at_link']) || l['record_phone_hmac_at_link'] instanceof Uint8Array).toBe(true);
    expect(Buffer.from(l['record_phone_hmac_at_link']).equals(rec)).toBe(true);
    expect(r.body).toMatchObject({ relationship: 'child', display_name: 'Milan Synthetic' });
  });

  it('a code without sex_snapshot leaves the link sex_snapshot NULL (restriction not enforced)', async () => {
    const f = setup({ code: { sex_snapshot: null } }); await f.redeem();
    expect(f.links()[0]!['sex_snapshot']).toBeNull();
  });
});

describe('US-EN-03.3/.4 every failure is one identical 422; each one counts', () => {
  const causes: Array<[string, (f: Fx) => { code?: string; as?: Record<string, any> }]> = [
    ['unknown code', () => ({ code: 'ZZZZZ-ZZZZZ' })],
    ['wrong phone (another account with a different number)', (f) => ({ as: f.w.seedAccount(OTHER_PHONE) })],
    ['expired code', (f) => { f.code['expires_at'] = new Date(Date.parse(f.w.now()) - 1000).toISOString(); return {}; }],
    ['revoked code', (f) => { Object.assign(f.code, { status: 'revoked', revoke_reason: 'staff' }); return {}; }],
    ['already redeemed (by another account)', (f) => { const x = f.w.seedAccount(THIRD_PHONE); Object.assign(f.code, { status: 'redeemed', redeemed_at: f.w.now(), redeemed_account_id: x['id'] }); return {}; }],
    ['a character outside the code alphabet (U)', () => ({ code: 'ULTRAUUUUU' })],
    ['a code of another tenant', (f) => { f.w.t['link_codes']!.splice(0, 1, { ...f.code, tenant_id: TENANT_B, code_hmac: linkCodeHmac(TENANT_B, CODE) }); return {}; }],
  ];
  const shapes: unknown[] = [];
  for (const [name, arrange] of causes) {
    it(`${name} -> 422 engagement.link_code_invalid, nothing else changes, failure counter +1 (persisted), metric invalid`, async () => {
      const f = setup(); const a = arrange(f); const who = a.as ?? f.acct;
      const before = JSON.stringify([f.w.t['account_patient_links'], f.w.t['link_codes']]);
      const e = await rejection(f.redeem(a.code ?? CODE, who));
      expect(e.code).toBe(INVALID); expect(e.statusCode).toBe(422); shapes.push(shape(e));
      expect(JSON.stringify([f.w.t['account_patient_links'], f.w.t['link_codes']])).toBe(before);
      expect(f.w.jobs('engagement.backfill_link')).toHaveLength(0); expect(f.w.audit.filter((x) => x['action'] === 'app_link.redeem')).toHaveLength(0);
      expect(f.w.commit.calls).toBe(1);                                                    // ctx.commitOnError() (08 A19 P-42)
      const c = counters(f.w); expect(c).toHaveLength(1); expect(c[0]!['counter_key']).toMatch(new RegExp(`^linkfail:${who['id']}:`)); expect(c[0]!['last_value']).toBe(1);
      expect(redeemMetric(f.w, 'invalid')).toHaveLength(1);
    });
  }
  it('the response is byte-identical for every cause (no validity oracle)', () => { expect(shapes.length).toBe(causes.length); expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1); });

  it('reuse: after A1 redeemed the code, another account redeeming it gets 422', async () => {
    const f = setup(); expect((await f.redeem()).status).toBe(201);
    const a2 = f.w.seedAccount(OTHER_PHONE); const e = await rejection(f.redeem(CODE, a2)); expect(e.code).toBe(INVALID);
    expect(f.w.t['account_patient_links']).toHaveLength(1); // only A1's link
    expect(f.links(a2['id'])).toHaveLength(0);
  });
});

describe('US-EN-03.5 failure counter: persists after each 422, 429 after 5 (per account, per hour)', () => {
  it('each wrong code -> 422 and the counter row survives the 422 (commitOnError); the 6th attempt -> 429 common.rate_limited and the DEFINER is not called, even with the right code', async () => {
    const f = setup();
    for (let i = 1; i <= 5; i++) {
      const e = await rejection(f.redeem(`WRONG-0000${i}`)); expect(e.code).toBe(INVALID);
      expect(counters(f.w)).toHaveLength(1); expect(counters(f.w)[0]!['last_value']).toBe(i); expect(f.w.commit.calls).toBe(i);
    }
    expect(counters(f.w)[0]!['counter_key']).toMatch(new RegExp(`^linkfail:${f.acct['id']}:\\d{10}$`));
    const calls = f.w.definerCalls.length;
    const e6 = await rejection(f.redeem(CODE)); expect(e6.code).toBe('common.rate_limited'); expect(e6.statusCode).toBe(429);
    expect(f.w.definerCalls.length).toBe(calls);
    expect(f.code['status']).toBe('issued'); expect(f.links()).toHaveLength(0);
  });
  it('the limit is per account (A2 is unaffected) and per hour (the next hour bucket redeems again)', async () => {
    const f = setup(); for (let i = 0; i < 5; i++) await rejection(f.redeem('WRONG-00000'));
    expect((await rejection(f.redeem(CODE))).code).toBe('common.rate_limited');
    const a2 = f.w.seedAccount(OTHER_PHONE); expect((await rejection(f.redeem('WRONG-00000', a2))).code).toBe(INVALID);   // 422, not 429
    f.w.advance(61 * 60_000);
    expect((await f.redeem()).status).toBe(201);
  });
  it('without commitOnError the counter would roll back: the world proves the persisted row comes from ctx.commitOnError()', async () => {
    const f = setup(); const c = f.ctx(); c.commitOnError = () => {};   // a service that forgets it
    await expect(f.w.inTx(() => (handlers as any).redeemLinkCode({ params: {}, query: {}, headers: {}, body: { code: 'WRONG-00000' } }, c))).rejects.toMatchObject({ code: INVALID });
    expect(counters(f.w)).toHaveLength(0);
  });
});

describe('US-EN-03.8 limits -> 409 and the redemption rolls back (code still issued)', () => {
  it('max_profiles_per_account reached -> 409 engagement.link_limit_reached; code still `issued`, no link, no job, no access-log row, no counter, no commitOnError', async () => {
    const f = setup({ maxProfiles: 2 }); f.w.seedLink(f.acct['id'], P2, { relationship: 'other' }); f.w.seedLink(f.acct['id'], P3, { relationship: 'other' });
    const e = await rejection(f.redeem()); expect(e.code).toBe(LIMIT); expect(e.statusCode).toBe(409);
    expect(f.code).toMatchObject({ status: 'issued', redeemed_at: null, redeemed_account_id: null });
    expect(f.links()).toHaveLength(2); expect(f.w.jobs('engagement.backfill_link')).toHaveLength(0);
    expect(f.w.audit.filter((a) => a['action'] === 'app_link.redeem')).toHaveLength(0); expect(counters(f.w)).toHaveLength(0); expect(f.w.commit.calls).toBe(0);
    expect(f.w.definerCalls.length).toBeGreaterThan(0);                                      // the redemption DID run inside the transaction and was rolled back
    expect(redeemMetric(f.w, 'limit')).toHaveLength(1);
  });
  it('max_accounts_per_patient reached -> 409 and rollback; freeing a slot lets the same code redeem later', async () => {
    const f = setup({ maxAccountsPerPatient: 1 }); const x = f.w.seedAccount(THIRD_PHONE); const xl = f.w.seedLink(x['id'], P, { relationship: 'other' });
    expect((await rejection(f.redeem())).code).toBe(LIMIT); expect(f.code['status']).toBe('issued'); expect(f.links()).toHaveLength(0);
    Object.assign(xl, { status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'patient_request', revoked_at: f.w.now() });
    expect((await f.redeem()).status).toBe(201); expect(f.code['status']).toBe('redeemed');
  });
  it('only ACTIVE links count: a revoked and a suspended link do not use up the account limit', async () => {
    const f = setup({ maxProfiles: 2 }); f.w.seedLink(f.acct['id'], P2, { relationship: 'other' });
    f.w.seedLink(f.acct['id'], P3, { relationship: 'other', status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'patient_request', revoked_at: f.w.now() });
    f.w.seedLink(f.acct['id'], P4, { relationship: 'other', status: 'suspended', suspend_reason: 'dormant', suspended_at: f.w.now() });
    expect((await f.redeem()).status).toBe(201);
  });
  it('a failure AFTER the redemption (the backfill enqueue) rolls everything back: code issued, no link (atomic transaction)', async () => {
    const f = setup(); const c = f.ctx(); const q = c.tx.query.bind(c.tx);
    c.tx.query = async (text: string, v?: unknown[]) => { if (/enqueue_job/i.test(text)) throw new Error('queue down'); return q(text, v); };
    const e = await rejection(f.w.inTx(() => (handlers as any).redeemLinkCode({ params: {}, query: {}, headers: {}, body: { code: CODE } }, c)));
    expect(f.w.definerCalls.length).toBeGreaterThan(0); expect(e.code).not.toBe('common.service_unavailable'); // the redemption DID run first (not the T-01 placeholder)
    expect(f.code['status']).toBe('issued'); expect(f.links()).toHaveLength(0); expect(f.w.commit.calls).toBe(0);
  });
});

describe('US-EN-03.2 / US-EN-04.4 / US-EN-06.7 an existing link of the same patient is widened or reactivated INSIDE the DEFINER -> 200', () => {
  it('same account, active report_link with a visible_from: 200, visible_from NULL (full history), method link_code, link_code_id / consent / sex copied, version + 1, backfill enqueued, no second link', async () => {
    const f = setup(); const l = f.w.seedLink(f.acct['id'], P, { method: 'report_link', visible_from: '2026-02-01T00:00:00.000Z', sex_snapshot: null });
    const r = await f.redeem();
    expect(r.status).toBe(200); expect(schemaErrors('Profile', r.body)).toEqual([]); expect(r.body['profile_id']).toBe(l['id']);
    expect(f.links()).toHaveLength(1);
    expect(l).toMatchObject({ status: 'active', visible_from: null, method: 'link_code', link_code_id: f.code['id'], consent_id: f.code['consent_id'], sex_snapshot: 'female', version: 2 });
    expect(f.code['status']).toBe('redeemed');
    expect(f.w.jobs('engagement.backfill_link').map((j) => j.payload['link_id'])).toEqual([l['id']]);
    expect(f.w.audit.filter((a) => a['action'] === 'app_link.redeem')).toHaveLength(1);
  });
  it('an existing link skips the limits (an account at max_profiles redeems a code for a patient it already has -> 200, not 409)', async () => {
    const f = setup({ maxProfiles: 1 }); f.w.seedLink(f.acct['id'], P, { relationship: 'other' });
    expect((await f.redeem()).status).toBe(200);
  });
  it('a SUSPENDED link is reactivated by the DEFINER (the patient column guard would refuse the same change outside it): active, suspension cleared, visible_from NULL, record phone hmac refreshed, backfill enqueued', async () => {
    const rec = phoneHmac(TENANT_B, '+99001000077');
    const f = setup({ code: { record_phone_hmac: rec } });
    const l = f.w.seedLink(f.acct['id'], P, { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: '2026-03-01T01:00:00.000Z', visible_from: '2026-02-01T00:00:00.000Z', record_phone_hmac_at_link: phoneHmac(TENANT_B, '+99001000066') });
    const r = await f.redeem();
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ profile_id: l['id'], status: 'active', method: 'link_code' });
    expect(l).toMatchObject({ status: 'active', suspend_reason: null, suspended_at: null, visible_from: null, method: 'link_code', link_code_id: f.code['id'], version: 2 });
    expect(Buffer.from(l['record_phone_hmac_at_link']).equals(rec)).toBe(true);
    expect(f.w.jobs('engagement.backfill_link').map((j) => j.payload['link_id'])).toEqual([l['id']]);
  });
  it('a suspended link is NOT reactivated by a code that fails (wrong phone): stays suspended', async () => {
    const f = setup(); const x = f.w.seedAccount(OTHER_PHONE); const l = f.w.seedLink(x['id'], P, { status: 'suspended', suspend_reason: 'dormant', suspended_at: f.w.now() });
    expect((await rejection(f.redeem(CODE, x))).code).toBe(INVALID); expect(l['status']).toBe('suspended');
  });
  it('a REVOKED link of the same patient does not count as existing: the redemption inserts a new link (201)', async () => {
    const f = setup(); f.w.seedLink(f.acct['id'], P, { status: 'revoked', revoked_by_kind: 'staff', revoked_reason_code: 'staff_error', revoked_at: f.w.now() });
    const r = await f.redeem(); expect(r.status).toBe(201); expect(f.links()).toHaveLength(2);
  });
});

describe('US-EN-04.6 a code issued as `self` for an account that already has a `self` link becomes `other`', () => {
  it('active self link to another patient -> new link relationship other (insert does not hit account_self__p_uq)', async () => {
    const f = setup(); f.w.seedLink(f.acct['id'], P2, { relationship: 'self' });
    const r = await f.redeem(); expect(r.status).toBe(201); expect(r.body['relationship']).toBe('other');
    expect(f.links().find((l) => l['patient_id'] === P)!['relationship']).toBe('other');
  });
  it('a SUSPENDED self link counts too', async () => {
    const f = setup(); f.w.seedLink(f.acct['id'], P2, { relationship: 'self', status: 'suspended', suspend_reason: 'dormant', suspended_at: f.w.now() });
    expect((await f.redeem()).body['relationship']).toBe('other');
  });
  it('a revoked self link does not; a code of another relationship is never changed', async () => {
    const f = setup(); f.w.seedLink(f.acct['id'], P2, { relationship: 'self', status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'patient_request', revoked_at: f.w.now() });
    expect((await f.redeem()).body['relationship']).toBe('self');
    const g = setup({ code: { relationship: 'spouse' } }); g.w.seedLink(g.acct['id'], P2, { relationship: 'self' });
    expect((await g.redeem()).body['relationship']).toBe('spouse');
  });
});

describe('permission, input and secrecy', () => {
  it('assertRole(engagement.link.redeem) runs before any query; without it: auth.forbidden and no statement at all', async () => {
    const f = setup(); await f.redeem(); const first = f.w.identity.calls[0]!; expect(first.permission).toBe('engagement.link.redeem'); expect(first.at).toBe(0);
    const g = setup(); g.w.identity.grants = []; const e = await rejection(g.redeem()); expect(e.code).toBe('auth.forbidden'); expect(g.w.stmts).toHaveLength(0);
  });
  for (const [name, body] of [['missing code', {}], ['9 characters', { code: 'ABCDE-FGH' }], ['14 characters', { code: 'ABCDE-FGH23XXX' }], ['illegal character', { code: 'ABCDE*FGH23' }], ['not a string', { code: 12345678901 }], ['unknown field', { code: CODE, patient_id: P }]] as const) {
    it(`bad body (${name}) -> 400 common.validation_failed, no redemption attempt`, async () => {
      const f = setup(); const e = await rejection(f.w.inTx(() => (handlers as any).redeemLinkCode({ params: {}, query: {}, headers: {}, body }, f.ctx())));
      expect(e.code).toBe('common.validation_failed'); expect(f.w.definerCalls).toHaveLength(0); expect(f.code['status']).toBe('issued');
    });
  }
  it('the patient id comes only from the code: a body patient_id is refused (never accepted from the client)', async () => {
    const f = setup(); const e = await rejection(f.w.inTx(() => (handlers as any).redeemLinkCode({ params: {}, query: {}, headers: {}, body: { code: CODE, patient_id: P2 } }, f.ctx())));
    expect(e.code).toBe('common.validation_failed'); expect(f.links()).toHaveLength(0);
  });
  it('never logs / audits / labels the plaintext code, the phone, a phone digit string or a hex HMAC (success and failure)', async () => {
    const f = setup(); await rejection(f.redeem('WRONG-00000')); await f.redeem();
    const seen = f.w.observed(); const hex = linkCodeHmac(f.w.tenantId, CODE).toString('hex');
    for (const bad of ['ABCDEFGH23', 'ABCDE-FGH23', 'WRONG-00000', 'WRONG00000', PHONE, PHONE.slice(1), hex, phoneHmac(f.w.tenantId, PHONE).toString('hex')]) expect(seen).not.toContain(bad);
  });
});

describe('source guards (02-TRD §4.3.2, 05-SCHEMA §4: the redemption and the reactivation exist only inside the DEFINER)', () => {
  const dir = join(REPO_ROOT, 'services/api/src/modules/engagement');
  const files = (d: string): string[] => { const out: string[] = []; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...files(p)); } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p); } return out; };
  const src = () => files(dir).map((p) => ({ p: relative(REPO_ROOT, p), s: readFileSync(p, 'utf8') }));
  it('link.service.ts calls app.engagement_redeem_link_code and ctx.commitOnError()', () => {
    const s = readFileSync(join(dir, 'service/link.service.ts'), 'utf8');
    expect(s).toMatch(/engagement_redeem_link_code/); expect(s).toMatch(/commitOnError/);
  });
  it('no module code UPDATEs link_codes to `redeemed` or an account_patient_links row to `active` (only the DEFINER may)', () => {
    for (const { p, s } of src()) {
      expect(s, p).not.toMatch(/UPDATE\s+engagement\.link_codes[\s\S]{0,300}status\s*=\s*'redeemed'/i);
      expect(s, p).not.toMatch(/UPDATE\s+engagement\.account_patient_links[\s\S]{0,400}status\s*=\s*'active'/i);
    }
  });
  it('no hex decode of an HMAC anywhere in the linking code (08 A5.5: bytea = bytea)', () => {
    for (const { p, s } of src().filter((x) => /link|account|otp/i.test(x.p))) expect(s, p).not.toMatch(/decode\(\s*[^)]*,\s*'hex'\s*\)/i);
  });
});
