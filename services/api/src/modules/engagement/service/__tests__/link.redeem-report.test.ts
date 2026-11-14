// C16.T-L3 — Redeem report link E15 `redeemReportLink` (POST /v1/engagement/me/profiles/redeem-report-link; 02-TRD §4.3.3, §5 E15, §6.1 redeemPortalLinkForApp row, §4.3.5 last paragraph;
//  03-APP-FLOW L-2 / L-4; 05-SCHEMA §6.1 app.engagement_apply_report_link + §4 column guard + PAT_LINK_INS; PRD US-EN-04.1-6, US-EN-06.7; 07-SECURITY E14/E15 row, probes P-L4/P-L6/P-L9; CR-C16-008).
// done_when: URL validation; visible_from rule (CR-C16-008 fake). tests: C6 fake failure -> identical 422; visible_from filtering of older reports; later code widens history;
//   suspended link reactivated via engagement_apply_report_link with visible_from = releasedAt; self -> other rule.
// Fails now: handlers/index.ts maps redeemReportLink to the T-01 placeholder (common.service_unavailable); service/link.service.ts does not exist.
//
// SEAMS (spec fixes behaviour, not file names; same convention as membership.handlers.test.ts):
//   handlers.redeemReportLink(req:{params,query,headers,body:{link_url}}, ctx) -> {status:201|200, body: Profile}; errors are thrown LimsError(code).
//   ctx = {tenantId, actor:{type:'patient', id: membership_id}, tx, now(), audit:{access}, ports:{IdentityPort, ReportingPort, FrontdeskPort}, log, commitOnError()}.
//   Permission engagement.link.redeem via IdentityPort.assertRole(ctx,{permission}) BEFORE any tx.query. The account is resolved from the actor's membership (engagement.accounts, PAT_ACC);
//   its phone_e164 (never a client value) goes to ReportingPort.redeemPortalLinkForApp(ctx, {linkToken, phoneE164}). Portal origin = process.env.LIMS_ORIGIN_PORTAL (read at call time or lazily; set below before import).
//   DB = world of __tests__/link.world.ts on the shared FakeDb: SINGLE-TABLE statements only, PAT_ACC for the patient actor, the partial unique indexes, PAT_LINK_INS (patient may insert only method 'report_link' for its own
//   account) and the §4 column guard (a direct patient UPDATE of status->active / visible_from / method raises `immutable_row`): reactivate / widen ONLY through `SELECT * FROM app.engagement_apply_report_link($1, $2)` (the world emulates the DEFINER).
//   enqueue = `SELECT app.enqueue_job('engagement.backfill_link', {link_id,..}, ..)`; access log = ctx.audit.access({action:'app_link.redeem', entityType:'app_link', entityId: link id}).
//   Assumptions where the spec is silent (not asserted beyond the status class): new-link display_name is any 1..200 char placeholder (real name arrives with the backfill task); a non-patient / unknown membership is refused (any 4xx);
//   a lost race on the unique index ends in a 2xx or a 4xx, never a 5xx / second row. NOT covered here (other tasks): E14 code redemption + code-widening in SQL (T-L2, SQL probe), the per-patient limit (mechanism unspecified), listing/RLS reads (T-P1/T-P3).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../../handlers/index.js';
import { ACC1, ACC2, ACC3, HMAC1, HMAC2, ID, PAT_X, PAT_Y, PAT_Z, PERM, PHONE1, PHONE2, REL_NEW, REL_OLD, REL_T, T0, TA, TOK, TOK64, link, makeWorld, ms, url, ORIGIN, type World } from '../../__tests__/link.report.world.js';

vi.hoisted(() => { process.env['LIMS_ORIGIN_PORTAL'] = 'https://portal.lims.test'; }); // = ORIGIN of link.world.ts (hoisted: must not reference imports)

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const IDEM = { 'idempotency-key': 'k-0001' };
const redeem = (w: World, linkUrl: unknown, account = ACC1, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  (handlers as any)['redeemReportLink']({ params: {}, query: {}, headers: IDEM, body: { link_url: linkUrl, ...extra } }, w.session(account, over));
const fail = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e: any) { return e; } throw new Error('expected rejection'); };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const shape = (e: any) => JSON.stringify({ status: e.statusCode, code: e.code, message: e.message, detail: e.detail, errors: e.errors });
const dbLinks = (w: World, account = ACC1, patient = PAT_X) => w.links(account).filter((l) => l['patient_id'] === patient);
const suspended = (o: Record<string, unknown> = {}) => link({ status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: '2026-10-25T00:00:00.000Z', ...o });
const noWritesNoJobs = (w: World) => { expect(w.writes()).toEqual([]); expect(w.jobs).toEqual([]); expect(w.audit.access).toEqual([]); };

describe('contract: operation, permission, fail-closed', () => {
  it('x-permission floor engagement.link.redeem; strict body; 201/200 Profile', () => {
    const op = opOf('redeemReportLink');
    expect(op['x-permission']).toBe(PERM);
    expect(op.requestBody.content['application/json'].schema).toMatchObject({ additionalProperties: false, required: ['link_url'] });
  });
  it('is a real handler (not the T-01 placeholder): a bare ctx fails closed with auth.unauthenticated', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    expect((await (handlers as any)['redeemReportLink']({ params: {}, query: {}, headers: IDEM, body: { link_url: url(TOK.X) } }, bare).catch((x: unknown) => x))?.code).toBe('auth.unauthenticated');
  });
  it('asserts engagement.link.redeem BEFORE any statement or port call; a denied role -> 403 and nothing else happens', async () => {
    const w = makeWorld();
    await redeem(w, url(TOK.X));
    expect(w.identity.asserted[0]).toEqual({ permission: PERM, at: 0 });
    const d = makeWorld(); d.identity.deny.add(PERM);
    expect(await code(redeem(d, url(TOK.X)))).toBe('auth.forbidden');
    expect(d.stmts).toEqual([]); expect(d.reporting.calls).toEqual([]);
  });
  it('an actor whose membership has no account is refused before the C6 call and writes nothing', async () => {
    const w = makeWorld();
    const e = await fail((handlers as any)['redeemReportLink']({ params: {}, query: {}, headers: IDEM, body: { link_url: url(TOK.X) } }, w.session(ACC1, { actor: { type: 'patient', id: ID(0x999) } })));
    expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(w.reporting.calls).toEqual([]); expect(w.writes()).toEqual([]);
  });
});

describe('US-EN-04.5 URL validation: only LIMS_ORIGIN_PORTAL + "/r/" + token ^[A-Za-z0-9_-]{22,64}$ -> else 400 and NO port call', () => {
  const bad: Array<[string, unknown]> = [
    ['foreign origin', `https://evil.example/r/${TOK.X}`],
    ['origin as prefix of a longer host', `https://portal.lims.test.evil.example/r/${TOK.X}`],
    ['userinfo trick', `https://portal.lims.test@evil.example/r/${TOK.X}`],
    ['scheme downgrade', `http://portal.lims.test/r/${TOK.X}`],
    ['other scheme', `javascript:alert(1)//${ORIGIN}/r/${TOK.X}`],
    ['other path', `${ORIGIN}/x/${TOK.X}`],
    ['app link path', `${ORIGIN}/app/r/${TOK.X}`],
    ['empty token', `${ORIGIN}/r/`],
    ['no path', ORIGIN],
    ['token 21 chars', url(TOK.X.slice(0, 21))],
    ['token 65 chars', url('A'.repeat(65))],
    ['token with illegal char', url(`${TOK.X.slice(0, 10)}!${TOK.X.slice(11)}`)],
    ['token with path suffix', `${url(TOK.X)}/extra`],
    ['token with query', `${url(TOK.X)}?utm=1`],
    ['token with fragment', `${url(TOK.X)}#x`],
    ['bare token (not a URL)', TOK.X],
    ['not a string (number)', 12345],
    ['not a string (object)', { href: url(TOK.X) }],
    ['null', null],
    ['empty string', ''],
    ['over 2000 chars', `${ORIGIN}/r/${'A'.repeat(2000)}`],
  ];
  it.each(bad)('%s -> 400 common.validation_failed, no port call, no write, no echo of the input', async (_n, input) => {
    const w = makeWorld();
    const e = await fail(redeem(w, input));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    expect(w.reporting.calls).toEqual([]); noWritesNoJobs(w);
    if (typeof input === 'string' && input.length > 8) expect(JSON.stringify({ d: e.detail, er: e.errors, m: e.message })).not.toContain(input.slice(8, 40));
  });
  it('accepts the token length bounds 22 and 64 (both reach C6)', async () => {
    for (const t of [TOK.X, TOK64]) { const w = makeWorld(); const out = await redeem(w, url(t)); expect(out.status, t.length.toString()).toBe(201); expect(w.reporting.calls[0]!.input.linkToken).toBe(t); }
  });
  it('body with extra keys (client-supplied phone_e164 / patient_id) -> 400 and no port call: the phone and the patient never come from the client', async () => {
    for (const extra of [{ phone_e164: PHONE2 }, { patient_id: PAT_Y }, { phoneE164: PHONE2 }]) {
      const w = makeWorld();
      expect(await code(redeem(w, url(TOK.X), ACC1, {}, extra))).toBe('common.validation_failed');
      expect(w.reporting.calls).toEqual([]); noWritesNoJobs(w);
    }
    const w = makeWorld(); // missing link_url
    expect(await code((handlers as any)['redeemReportLink']({ params: {}, query: {}, headers: IDEM, body: {} }, w.session()))).toBe('common.validation_failed');
    expect(w.reporting.calls).toEqual([]);
  });
});

describe('US-EN-04.1 new link from a report link (A1 phone P1, report R of patient X released at T)', () => {
  it('calls ReportingPort.redeemPortalLinkForApp ONCE under the patient ctx with the token and the ACCOUNT phone; FrontdeskPort untouched', async () => {
    const w = makeWorld(); const ctx = w.session();
    await (handlers as any)['redeemReportLink']({ params: {}, query: {}, headers: IDEM, body: { link_url: url(TOK.X) } }, ctx);
    expect(w.reporting.calls).toHaveLength(1);
    const c = w.reporting.calls[0]!;
    expect(c.input).toEqual({ linkToken: TOK.X, phoneE164: PHONE1 });
    expect(c.ctx.actor.type).toBe('patient'); expect(c.ctx.tenantId).toBe(TA); expect(c.ctx.tx).toBe(ctx.tx); // in the caller's transaction (03-IC §4.7)
    expect(w.frontdesk.calls).toEqual([]);
    const w2 = makeWorld(); w2.tokens[TOK.X]!.phone = PHONE2; // account B's own phone is what travels, never account A's
    await redeem(w2, url(TOK.X), ACC2);
    expect(w2.reporting.calls[0]!.input).toEqual({ linkToken: TOK.X, phoneE164: PHONE2 });
  });
  it('201 Profile {method:report_link, status:active, relationship:self, history_from = T} (schema-valid, no ids of the patient / tenant / phone), link row bound to the CALLER account and the PORT patient', async () => {
    const w = makeWorld();
    const out = await redeem(w, url(TOK.X));
    expect(out.status).toBe(201);
    expect(schemaErrors('Profile', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ method: 'report_link', status: 'active', relationship: 'self' });
    expect(ms(out.body.history_from)).toBe(ms(REL_T));
    expect(JSON.stringify(out.body)).not.toMatch(new RegExp(`${PAT_X}|${TA}|98000000|${TOK.X}`));
    const rows = dbLinks(w);
    expect(rows).toHaveLength(1);
    expect(out.body.profile_id).toBe(rows[0]!['id']); // profile_id = link id
    expect(rows[0]).toMatchObject({ tenant_id: TA, account_id: ACC1, patient_id: PAT_X, method: 'report_link', status: 'active', link_code_id: null });
    expect(ms(rows[0]!['visible_from'])).toBe(ms(REL_T));
    expect(Buffer.from(rows[0]!['record_phone_hmac_at_link']).equals(HMAC1)).toBe(true); // = the account's phone_hmac (TRD §4.3.3 step 4)
    expect(String(rows[0]!['display_name']).length).toBeGreaterThanOrEqual(1);
  });
  it('another account gets its own link of its own phone/hmac: ids derive from the session, not from the request', async () => {
    const w = makeWorld(); w.tokens[TOK.X]!.phone = PHONE2;
    const out = await redeem(w, url(TOK.X), ACC2);
    expect(out.status).toBe(201);
    expect(dbLinks(w, ACC2)[0]).toMatchObject({ account_id: ACC2, patient_id: PAT_X });
    expect(Buffer.from(dbLinks(w, ACC2)[0]!['record_phone_hmac_at_link']).equals(HMAC2)).toBe(true);
    expect(dbLinks(w, ACC1)).toEqual([]);
  });
  it('no write before the C6 call; afterwards: backfill enqueued for the new link, one access-log entry app_link.redeem', async () => {
    const w = makeWorld();
    const out = await redeem(w, url(TOK.X));
    const portAt = w.events.indexOf('port'); expect(portAt).toBeGreaterThan(-1);
    const writeAt = w.events.findIndex((e) => /^stmt:\s*(insert|update|delete)\b|enqueue_job|engagement_apply_report_link/i.test(e));
    expect(writeAt).toBeGreaterThan(portAt);
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0]!.identifier).toBe('engagement.backfill_link'); expect(w.jobs[0]!.payload.link_id).toBe(out.body.profile_id);
    expect(w.audit.access).toHaveLength(1);
    expect(w.audit.access[0]).toMatchObject({ action: 'app_link.redeem', entityType: 'app_link', entityId: out.body.profile_id });
  });
  it('REQ-SEC: token, URL and phone appear in no log line, audit entry or job payload', async () => {
    const w = makeWorld();
    await redeem(w, url(TOK.X));
    const blob = JSON.stringify([w.logs, w.audit, w.jobs.map((j) => j.payload)]);
    for (const secret of [TOK.X, url(TOK.X), PHONE1, PHONE1.slice(1)]) expect(blob).not.toContain(secret);
    const f = makeWorld(); await redeem(f, url(TOK.UNKNOWN)).catch(() => undefined);
    expect(JSON.stringify([f.logs, f.audit])).not.toMatch(new RegExp(`${TOK.UNKNOWN}|${PHONE1.slice(1)}`));
  });
  it('the same link again (A1, same token) is idempotent: 200 with the SAME profile, one row, same visible_from', async () => {
    const w = makeWorld();
    const first = await redeem(w, url(TOK.X)); const second = await redeem(w, url(TOK.X));
    expect(first.status).toBe(201); expect(second.status).toBe(200);
    expect(second.body.profile_id).toBe(first.body.profile_id);
    expect(dbLinks(w)).toHaveLength(1); expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_T));
    expect(w.jobs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('US-EN-04.1 visible_from rule (P-L6): reports released before T stay hidden, at/after T are visible', () => {
  it('stored visible_from = releasedAt to the millisecond; 1 ms before -> hidden, at T and after -> visible; older reports of X are filtered out', async () => {
    const w = makeWorld();
    await redeem(w, url(TOK.X));
    const at = (d: number) => new Date(ms(REL_T)! + d).toISOString();
    expect(w.visible(ACC1, PAT_X, at(-1))).toBe(false);
    expect(w.visible(ACC1, PAT_X, at(0))).toBe(true);
    expect(w.visible(ACC1, PAT_X, at(1))).toBe(true);
    expect(w.visible(ACC1, PAT_X, REL_OLD)).toBe(false); // an older report of X
    expect(w.visible(ACC1, PAT_X, REL_NEW)).toBe(true);
    expect(w.visible(ACC2, PAT_X, REL_NEW)).toBe(false); // another account sees nothing
  });
  it('a LATER (older-release) report link of the same patient widens the history; a newer one never narrows it', async () => {
    const w = makeWorld();
    const a = await redeem(w, url(TOK.X_NEW)); expect(a.status).toBe(201); expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_NEW));
    const b = await redeem(w, url(TOK.X)); expect(b.status).toBe(200); expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_T)); // least(Nov 1, Oct 20)
    const c = await redeem(w, url(TOK.X_OLD)); expect(c.status).toBe(200); expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_OLD));
    const d = await redeem(w, url(TOK.X_NEW)); expect(d.status).toBe(200); expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_OLD)); // not narrowed again
    expect(dbLinks(w)).toHaveLength(1);
    expect(ms(d.body.history_from)).toBe(ms(REL_OLD));
    expect(w.applied.map((x) => ms(x.releasedAt as string))).toEqual([ms(REL_NEW), ms(REL_T), ms(REL_OLD), ms(REL_NEW)]); // the DEFINER is the only writer, called with (patientId, releasedAt) on every redemption
    expect(w.applied.every((x) => x.patientId === PAT_X && x.accountId === ACC1)).toBe(true);
  });
  it('an existing active link with a LATER visible_from is widened to T (200, no second row)', async () => {
    const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(link({ visible_from: REL_NEW })) });
    const out = await redeem(w, url(TOK.X));
    expect(out.status).toBe(200); expect(dbLinks(w)).toHaveLength(1);
    expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_T));
    expect(w.applied).toHaveLength(1); expect(ms(w.applied[0]!.releasedAt as string)).toBe(ms(REL_T));
  });
  it('an existing active link with an EARLIER visible_from keeps it (least)', async () => {
    const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(link({ visible_from: REL_OLD })) });
    expect((await redeem(w, url(TOK.X))).status).toBe(200);
    expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_OLD));
  });
  it('US-EN-04.4 (as far as E15 goes): a link already widened by a LINK CODE (visible_from NULL, method link_code) stays full-history and keeps its method', async () => {
    const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(link({ method: 'link_code', link_code_id: ID(0xc0de), visible_from: null, relationship: 'self' })) });
    const out = await redeem(w, url(TOK.X));
    expect(out.status).toBe(200);
    expect(dbLinks(w)[0]).toMatchObject({ method: 'link_code', visible_from: null, relationship: 'self', status: 'active' });
    expect(schemaErrors('Profile', out.body)).toEqual([]); expect(out.body.history_from ?? undefined).toBeUndefined(); expect(out.body.method).toBe('link_code');
    expect(w.visible(ACC1, PAT_X, REL_OLD)).toBe(true);
  });
});

describe('US-EN-04.2 / 04.3 / C6 failure: every cause -> the identical 422 engagement.link_code_invalid, nothing written', () => {
  const causes: Array<[string, (w: World) => Promise<unknown>]> = [
    ['link sent to another phone (account B)', (w) => redeem(w, url(TOK.X), ACC2)],
    ['expired link', (w) => redeem(w, url(TOK.EXPIRED))],
    ['revoked link', (w) => redeem(w, url(TOK.REVOKED))],
    ['unknown token', (w) => redeem(w, url(TOK.UNKNOWN))],
    ['C6 fake failing with extra detail', (w) => { w.reporting.failWith = () => new LimsError('reporting.link_invalid', 'wrong phone for token'); return redeem(w, url(TOK.X)); }],
  ];
  it.each(causes)('%s', async (_n, run) => {
    const w = makeWorld();
    const e = await fail(run(w));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('engagement.link_code_invalid'); expect(e.statusCode).toBe(422);
    expect(w.reporting.calls).toHaveLength(1); // C6 was asked exactly once; C6 itself counts its failures
    expect(w.writes()).toEqual([]); expect(w.jobs).toEqual([]); expect(w.audit.access).toEqual([]); expect(w.links(ACC1).concat(w.links(ACC2))).toEqual([]);
    expect(JSON.stringify([e.detail, e.errors, e.message])).not.toMatch(/reporting|phone|expired|revoked|unknown|token/i);
  });
  it('the answers are byte-identical across causes (no validity oracle), with or without existing links of the account', async () => {
    const shapes: string[] = [];
    for (const [, run] of causes) shapes.push(shape(await fail(run(makeWorld()))));
    for (const [, run] of causes) shapes.push(shape(await fail(run(makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(link({ account_id: ACC1 }), link({ id: ID(0xc9), account_id: ACC2 })) })))));
    expect(new Set(shapes).size).toBe(1);
    expect(JSON.parse(shapes[0]!)).toMatchObject({ code: 'engagement.link_code_invalid', status: 422 }); // (not vacuously identical: the T-01 placeholder answers 503 for all)
  });
  it('a failure leaves an existing link untouched (no widening, no reactivation, no version bump)', async () => {
    const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(suspended({ visible_from: REL_NEW })) });
    const before = JSON.stringify(w.tables['account_patient_links']);
    expect(await code(redeem(w, url(TOK.EXPIRED)))).toBe('engagement.link_code_invalid');
    expect(JSON.stringify(w.tables['account_patient_links'])).toBe(before);
  });
  it('US-EN-04.2: after A1 linked, A2 (other phone) with the SAME link is refused identically and A1\'s link is unchanged', async () => {
    const w = makeWorld(); await redeem(w, url(TOK.X));
    const before = JSON.stringify(w.links(ACC1));
    expect(await code(redeem(w, url(TOK.X), ACC2))).toBe('engagement.link_code_invalid');
    expect(JSON.stringify(w.links(ACC1))).toBe(before); expect(w.links(ACC2)).toEqual([]);
  });
});

describe('US-EN-06.3 / L-4: a suspended link is reactivated ONLY through engagement_apply_report_link with visible_from = releasedAt', () => {
  it.each(['phone_mismatch', 'dormant'])('suspended (%s) -> 200, active, suspension cleared, visible_from = releasedAt, phone hmac refreshed, method unchanged, backfill enqueued', async (reason) => {
    const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(suspended({ suspend_reason: reason, method: 'link_code', link_code_id: ID(0xc0de), visible_from: null, record_phone_hmac_at_link: Buffer.alloc(32, 9) })) });
    const out = await redeem(w, url(TOK.X)); // a direct UPDATE of status / visible_from by the patient would raise immutable_row in this world (P-L9)
    expect(out.status).toBe(200); expect(schemaErrors('Profile', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ status: 'active', method: 'link_code' }); expect(ms(out.body.history_from)).toBe(ms(REL_T));
    expect(dbLinks(w)).toHaveLength(1);
    expect(dbLinks(w)[0]).toMatchObject({ status: 'active', suspend_reason: null, suspended_at: null, method: 'link_code', link_code_id: ID(0xc0de) });
    expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_T));
    expect(Buffer.from(dbLinks(w)[0]!['record_phone_hmac_at_link']).equals(HMAC1)).toBe(true);
    expect(w.applied).toHaveLength(1); expect(w.applied[0]).toMatchObject({ patientId: PAT_X, accountId: ACC1 }); expect(ms(w.applied[0]!.releasedAt as string)).toBe(ms(REL_T));
    expect(w.applied[0]!.result[0]).toMatchObject({ prior_status: 'suspended' });
    expect(w.jobs.map((j) => j.identifier)).toEqual(['engagement.backfill_link']); expect(w.jobs[0]!.payload.link_id).toBe(out.body.profile_id);
    expect(w.audit.access).toHaveLength(1); expect(w.audit.access[0]).toMatchObject({ action: 'app_link.redeem', entityType: 'app_link', entityId: out.body.profile_id });
    expect(w.visible(ACC1, PAT_X, REL_OLD)).toBe(false); expect(w.visible(ACC1, PAT_X, REL_T)).toBe(true);
  });
  it('reactivates only the link the proof names and only the caller\'s own: another account\'s suspended link and another patient\'s suspended link stay suspended', async () => {
    const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(suspended({ id: ID(0xc2), account_id: ACC2 }), suspended({ id: ID(0xc3), patient_id: PAT_Y }), suspended({ id: ID(0xc4) })) });
    const out = await redeem(w, url(TOK.X));
    expect(out.status).toBe(200); expect(out.body.profile_id).toBe(ID(0xc4));
    expect(w.tables['account_patient_links']!.filter((l) => l['status'] === 'suspended').map((l) => l['id']).sort()).toEqual([ID(0xc2), ID(0xc3)].sort());
  });
  it('a REVOKED link is not revived: the proof creates a NEW link (201) next to it', async () => {
    const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(link({ status: 'revoked', revoked_by_kind: 'account', revoked_at: '2026-10-10T00:00:00.000Z' })) });
    const out = await redeem(w, url(TOK.X));
    expect(out.status).toBe(201); expect(out.body.profile_id).not.toBe(ID(0xc1));
    expect(dbLinks(w)).toHaveLength(2); expect(w.tables['account_patient_links']!.find((l) => l['id'] === ID(0xc1))!['status']).toBe('revoked');
  });
});

describe('US-EN-04.6 self -> other (account already has an active or suspended self profile)', () => {
  const rel = async (seed: any[], token: string = TOK.X) => { const w = makeWorld({ seed: (x) => x.tables['account_patient_links']!.push(...seed) }); const out = await redeem(w, url(token)); return { w, out }; };
  it('first profile of the account -> self', async () => { const { out } = await rel([]); expect(out.body.relationship).toBe('self'); });
  it('account has an ACTIVE self profile (patient Y) -> the new profile is other, row too (the partial unique index would refuse a 2nd self)', async () => {
    const { w, out } = await rel([link({ id: ID(0xc5), patient_id: PAT_Y, relationship: 'self', method: 'self_registered' })]);
    expect(out.status).toBe(201); expect(out.body.relationship).toBe('other'); expect(dbLinks(w)[0]!['relationship']).toBe('other');
  });
  it('account has a SUSPENDED self profile -> other', async () => {
    const { out } = await rel([suspended({ id: ID(0xc5), patient_id: PAT_Y, relationship: 'self', method: 'self_registered' })]);
    expect(out.body.relationship).toBe('other');
  });
  it('account has only a REVOKED self profile -> self again; only non-self profiles -> self', async () => {
    expect((await rel([link({ id: ID(0xc5), patient_id: PAT_Y, relationship: 'self', status: 'revoked', revoked_by_kind: 'account', revoked_at: '2026-10-10T00:00:00.000Z' })])).out.body.relationship).toBe('self');
    expect((await rel([link({ id: ID(0xc5), patient_id: PAT_Y, relationship: 'child' })])).out.body.relationship).toBe('self');
  });
  it('another account\'s self profile does not count; an existing link keeps its relationship (no rewrite on widen/reactivate)', async () => {
    expect((await rel([link({ id: ID(0xc5), account_id: ACC3, patient_id: PAT_Y, relationship: 'self' })])).out.body.relationship).toBe('self');
    const { w, out } = await rel([link({ id: ID(0xc5), patient_id: PAT_Y, relationship: 'self' }), link({ relationship: 'child', visible_from: REL_NEW })]);
    expect(out.status).toBe(200); expect(out.body.relationship).toBe('child'); expect(dbLinks(w)[0]!['relationship']).toBe('child');
  });
});

describe('limits (TRD §4.3.3 step 4 -> §4.3.2 step 4) and races', () => {
  const settings = (n: number) => (x: { tables: Record<string, any[]> }) => { x.tables['settings']![0]!['max_profiles_per_account'] = n; };
  it('account at max_profiles_per_account (read from settings, not hard-coded) active links -> 409 engagement.link_limit_reached and no link / job / audit; a revoked link does not count', async () => {
    const w = makeWorld({ seed: (x) => { settings(2)(x); x.tables['account_patient_links']!.push(link({ id: ID(0xc5), patient_id: PAT_Y, relationship: 'child' }), link({ id: ID(0xc6), patient_id: PAT_Z, relationship: 'child' })); } });
    const e = await fail(redeem(w, url(TOK.X)));
    expect(e.code).toBe('engagement.link_limit_reached'); expect(e.statusCode).toBe(409);
    expect(w.links(ACC1)).toHaveLength(2); expect(w.jobs).toEqual([]); expect(w.audit.access).toEqual([]);
    const ok = makeWorld({ seed: (x) => { settings(2)(x); x.tables['account_patient_links']!.push(link({ id: ID(0xc5), patient_id: PAT_Y, relationship: 'child' }), link({ id: ID(0xc6), patient_id: PAT_Z, relationship: 'child', status: 'revoked', revoked_by_kind: 'account', revoked_at: '2026-10-10T00:00:00.000Z' })); } });
    expect((await redeem(ok, url(TOK.X))).status).toBe(201);
  });
  it('an account AT the limit can still widen / reactivate its existing link for that patient (no new profile) -> 200', async () => {
    const w = makeWorld({ seed: (x) => { settings(2)(x); x.tables['account_patient_links']!.push(link({ visible_from: REL_NEW }), link({ id: ID(0xc6), patient_id: PAT_Z, relationship: 'child' })); } });
    expect((await redeem(w, url(TOK.X))).status).toBe(200); expect(ms(dbLinks(w)[0]!['visible_from'])).toBe(ms(REL_T));
  });
  it('two simultaneous redemptions of the same link by one account end with exactly ONE live link and no 5xx', async () => {
    const w = makeWorld();
    const r = await Promise.allSettled([redeem(w, url(TOK.X)), redeem(w, url(TOK.X)), redeem(w, url(TOK.X))]);
    for (const x of r) { if (x.status === 'fulfilled') expect([200, 201]).toContain(x.value.status); else { expect(x.reason).toBeInstanceOf(LimsError); expect(x.reason.statusCode).toBeLessThan(500); } }
    expect(r.some((x) => x.status === 'fulfilled')).toBe(true);
    expect(dbLinks(w).filter((l) => ['active', 'suspended'].includes(l['status']))).toHaveLength(1);
  });
});
