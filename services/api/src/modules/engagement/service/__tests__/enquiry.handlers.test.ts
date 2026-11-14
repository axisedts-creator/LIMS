// C16.T-N1 — Enquiries: patient E48 listMyEnquiries, E49 createMyEnquiry, E50 getMyEnquiry, E51 replyMyEnquiry; staff N1 listEnquiries, N2 getEnquiry, N3 replyEnquiry, N4 closeEnquiry
// (06-PLAN row T-N1 "transitions; open-limit" / "probes; closed reply -> 409"; 02-TRD §4.13, §5 E48-E51 + N1-N4, §7; 03-APP-FLOW §4.5; 05-SCHEMA enquiries / enquiry_messages + §8 policy rows;
//  PRD US-EN-18.1-18.4; 07-SECURITY §3 (P3 free text never logged / never in notifications), §6 probes, REQ-SEC-100 open-enquiry cap).
// Fails now: handlers/index.ts maps all eight operationIds to the T-01 placeholder (common.service_unavailable); no enquiry service exists.
//
// SEAMS (same convention as notification.handlers.test.ts / membership.handlers.test.ts): handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; errors are thrown LimsError(code).
//   ctx = {tenantId, actor:{type:'patient'|'user', id}, tx, now(), audit, log, metrics, ports:{IdentityPort}}. Permission = ctx.ports.IdentityPort.assertRole(ctx,{permission}) BEFORE any tx.query:
//   E48/E50 engagement.self.read, E49/E51 engagement.enquiry.create, N1/N2 engagement.enquiry.read, N3/N4 engagement.enquiry.respond. A patient actor's actor.id is the account's membership_id
//   (accounts.membership_id); the account row is found from it. If-Match arrives as header 'if-match' = "<version>" (02-CV §4.2): absent -> common.precondition_required, malformed -> common.validation_failed,
//   stale -> common.version_conflict. DB = __tests__/enquiries.world.ts (tenant RLS + PAT_ACC, append-only messages, FOR UPDATE / pg_advisory_xact_lock modelled).
// Assumptions where the spec is silent (stated, asserted only as far as written; cite if disputed):
//   - a reply that does not change the status (patient on `open`, staff on `answered`) still appends the message, sets last_message_at = ctx.now() and bumps version; patient reply on `answered` -> `open`
//     (US-EN-18.4), staff reply on `open` -> `answered` (18.2); close sets closed_at = ctx.now() and appends nothing and notifies nothing.
//   - "open enquiries" for the per-account cap (5, TRD E49) = status 'open'; closed ones never count, another account's never count; whether `answered` counts is NOT asserted.
//   - profile_id on a DTO = account_patient_links.id of the enquiry's patient for the caller's account (patients never see patient_id, 07-SECURITY §7.1); staff DTOs carry patient_id (N2) when set.
//   - E49 with a profile_id that is not an ACTIVE link of the caller's account -> common.not_found (nothing written).
//   - the message row: author_id = the account id or the actor id; created_by = ctx.actor.id. The staff reply writes ONE notifications row {kind 'enquiry_reply', entity_type 'enquiry', entity_id,
//     account_id, patient_id of the enquiry, created_by = staff actor} and nothing else outside enquiries / enquiry_messages / notifications (no SMS, no outbox, no port call) carries the text.
//   - category_code membership of the coded set enquiry_categories and the 'enquiries_enabled' gate are the only E49 checks besides schema; the gate reads engagement.settings.enquiries_enabled
//     (DDL default false; a missing row is not tested) and fails with 403 common.feature_disabled before anything is written. Pipeline checks (schema min/max, Idempotency-Key replay, x-permission floor)
//     are not re-tested except where a handler must refuse bad input itself (handlers are driven directly).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ACC1, ACC2, ACC_B, EQ, ID, LINK1, MEMBERSHIP, NOW, P, PAT1, PAT2, STAFF, TA, TB, makeWorld, type World } from '../../__tests__/enquiries.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

type Who = 'patient' | 'staff';
type Opt = { tenant?: string; account?: string; over?: Record<string, unknown> };
const run = async (w: World, op: string, who: Who, req: Record<string, any> = {}, o: Opt = {}) => {
  const s = w.session(who, o.over, o.tenant, o.account);
  try { return await (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, s.ctx); } finally { s.release(); }
};
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const ifm = (v: number | string) => ({ 'if-match': `"${v}"` });
const hdr = (out: any, name: string) => out.headers?.[name] ?? out.headers?.[name.toLowerCase()];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
const idsOf = (out: any): string[] => out.body.data.map((e: any) => e.id);

// patient
const myList = (w: World, query: Record<string, unknown> = {}, o: Opt = {}) => run(w, 'listMyEnquiries', 'patient', { query }, o);
const myGet = (w: World, id: string, o: Opt = {}) => run(w, 'getMyEnquiry', 'patient', { params: { enquiry_id: id } }, o);
const VALID = { category_code: 'report', subject: 'Synthetic subject', message: 'Synthetic message text.' };
const myCreate = (w: World, body: unknown = VALID, o: Opt = {}) => run(w, 'createMyEnquiry', 'patient', { body }, o);
const myReply = (w: World, id: string, message: unknown, version: number | string | undefined, o: Opt = {}) =>
  run(w, 'replyMyEnquiry', 'patient', { params: { enquiry_id: id }, body: { message }, headers: version === undefined ? {} : ifm(version) }, o);
// staff
const stList = (w: World, query: Record<string, unknown> = {}, o: Opt = {}) => run(w, 'listEnquiries', 'staff', { query }, o);
const stGet = (w: World, id: string, o: Opt = {}) => run(w, 'getEnquiry', 'staff', { params: { enquiry_id: id } }, o);
const stReply = (w: World, id: string, message: unknown, version: number | string | undefined, o: Opt = {}) =>
  run(w, 'replyEnquiry', 'staff', { params: { enquiry_id: id }, body: { message }, headers: version === undefined ? {} : ifm(version) }, o);
const stClose = (w: World, id: string, version: number | string | undefined, o: Opt = {}) =>
  run(w, 'closeEnquiry', 'staff', { params: { enquiry_id: id }, headers: version === undefined ? {} : ifm(version) }, o);

const OPS: Array<[string, string, Who]> = [
  ['listMyEnquiries', P.SELF_READ, 'patient'], ['createMyEnquiry', P.ENQ_CREATE, 'patient'], ['getMyEnquiry', P.SELF_READ, 'patient'], ['replyMyEnquiry', P.ENQ_CREATE, 'patient'],
  ['listEnquiries', P.ENQ_READ, 'staff'], ['getEnquiry', P.ENQ_READ, 'staff'], ['replyEnquiry', P.ENQ_RESPOND, 'staff'], ['closeEnquiry', P.ENQ_RESPOND, 'staff'],
];
// a request that passes input validation for every operation (used to prove the permission check comes first)
const REQ: Record<string, Record<string, any>> = {
  listMyEnquiries: {}, createMyEnquiry: { body: VALID }, getMyEnquiry: { params: { enquiry_id: EQ(1) } }, replyMyEnquiry: { params: { enquiry_id: EQ(1) }, body: { message: 'x' }, headers: ifm(3) },
  listEnquiries: {}, getEnquiry: { params: { enquiry_id: EQ(1) } }, replyEnquiry: { params: { enquiry_id: EQ(1) }, body: { message: 'x' }, headers: ifm(3) }, closeEnquiry: { params: { enquiry_id: EQ(1) }, headers: ifm(3) },
};

describe('contract: operations exist and floors match 02-TRD §5 / §7', () => {
  it('x-permission floors', () => { for (const [op, perm] of OPS) expect(opOf(op)['x-permission'], op).toBe(perm); });
  it('every operation has a real handler (not the T-01 placeholder): a bare ctx fails closed with auth.unauthenticated', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    for (const [op] of OPS) {
      const e = await (handlers as any)[op]({ params: { enquiry_id: EQ(1) }, query: {}, headers: ifm(3), body: VALID }, bare).catch((x: unknown) => x);
      expect(e?.code, op).toBe('auth.unauthenticated');
    }
  });
  it('request bodies are closed (no mass assignment): E49 {category_code, subject, message, profile_id?}; E51 / N3 {message}', () => {
    const c = opOf('createMyEnquiry').requestBody.content['application/json'].schema;
    expect(c.additionalProperties).toBe(false);
    expect(Object.keys(c.properties).sort()).toEqual(['category_code', 'message', 'profile_id', 'subject']);
    for (const op of ['replyMyEnquiry', 'replyEnquiry']) {
      const b = opOf(op).requestBody.content['application/json'].schema;
      expect(b.additionalProperties, op).toBe(false);
      expect(Object.keys(b.properties), op).toEqual(['message']);
    }
  });
});

describe('permissions: asserted first, before any statement; a denied role gets auth.forbidden and nothing runs', () => {
  for (const [op, perm, who] of OPS) {
    it(`${op} asserts ${perm}`, async () => {
      const w = makeWorld();
      await run(w, op, who, REQ[op]);
      expect(w.identity.asserted[0], op).toEqual({ permission: perm, at: 0 });
      const w2 = makeWorld();
      w2.identity.deny.add(perm);
      expect(await code(run(w2, op, who, REQ[op])), op).toBe('auth.forbidden');
      expect(w2.stmts, op).toEqual([]);
    });
  }
  it('a role without engagement.enquiry.respond can read but not reply or close', async () => {
    const w = makeWorld();
    w.grants.delete(P.ENQ_RESPOND);
    expect(await code(stGet(w, EQ(1)))).toBe('RESOLVED');
    expect(await code(stReply(w, EQ(1), 'x', 3))).toBe('auth.forbidden');
    expect(await code(stClose(w, EQ(1), 3))).toBe('auth.forbidden');
    expect(w.writes()).toEqual([]);
  });
});

describe('E49 createMyEnquiry (US-EN-18.1)', () => {
  it('creates an open enquiry with its first message: 201, Enquiry schema, no-store; one enquiries row + one enquiry_messages row', async () => {
    const w = makeWorld();
    const out: any = await myCreate(w, { ...VALID, subject: 'Where is my report?', message: 'Synthetic: when will it be ready?' });
    expect(out.status).toBe(201);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(schemaErrors('Enquiry', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ category_code: 'report', subject: 'Where is my report?', status: 'open', version: 1, last_message_at: NOW });
    expect(out.body.messages).toEqual([{ author_kind: 'patient', body: 'Synthetic: when will it be ready?', created_at: NOW }]);
    for (const k of ['patient_id', 'account_id', 'tenant_id']) expect(out.body, k).not.toHaveProperty(k);
    const row = w.enquiry(out.body.id)!;
    expect(row).toMatchObject({ tenant_id: TA,account_id: ACC1, patient_id: null, category_code: 'report', subject: 'Where is my report?', status: 'open', closed_at: null, version: 1, created_by: MEMBERSHIP[ACC1] });
    expect(iso(row['last_message_at'])).toBe(NOW);
    const msgs = w.messages(out.body.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ account_id: ACC1, author_kind: 'patient', body: 'Synthetic: when will it be ready?', created_by: MEMBERSHIP[ACC1] });
    expect([ACC1, MEMBERSHIP[ACC1]]).toContain(msgs[0]!['author_id']);
    expect(w.tables['notifications']).toEqual([]); // nobody is notified of a patient's own message
  });

  it('is visible to staff with engagement.enquiry.read as open (N1, N2) — and to nobody else', async () => {
    const w = makeWorld();
    const made: any = await myCreate(w);
    const list: any = await stList(w, { status: 'open' });
    expect(idsOf(list)).toContain(made.body.id);
    const one: any = await stGet(w, made.body.id);
    expect(one.body).toMatchObject({ status: 'open', subject: 'Synthetic subject' });
    expect(one.body.messages.map((m: any) => m.body)).toEqual(['Synthetic message text.']);
    expect(await code(stGet(w, made.body.id, { tenant: TB }))).toBe('common.not_found');
    expect(await code(myGet(w, made.body.id, { account: ACC2 }))).toBe('common.not_found');
  });

  it('boundaries: subject 120 and message 2000 are accepted; the 120-character limit counts characters, not UTF-16 units (120 emoji pass, 121 fail)', async () => {
    const w = makeWorld();
    expect((await myCreate(w, { ...VALID, subject: 'a'.repeat(120), message: 'b'.repeat(2000) }) as any).status).toBe(201);
    expect((await myCreate(w, { ...VALID, subject: '😀'.repeat(120) }) as any).status).toBe(201);
    expect(await code(myCreate(w, { ...VALID, subject: '😀'.repeat(121) }))).toBe('common.validation_failed');
  });

  const bad: Array<[string, unknown]> = [
    ['subject empty', { ...VALID, subject: '' }], ['subject 121', { ...VALID, subject: 'a'.repeat(121) }], ['message empty', { ...VALID, message: '' }], ['message 2001', { ...VALID, message: 'a'.repeat(2001) }],
    ['category missing', { subject: 'x', message: 'y' }], ['category bad pattern', { ...VALID, category_code: 'Report!' }], ['category 65', { ...VALID, category_code: 'a'.repeat(65) }],
    ['subject not a string', { ...VALID, subject: 7 }], ['message missing', { category_code: 'report', subject: 'x' }], ['profile_id not a uuid', { ...VALID, profile_id: 'nope' }],
    ['mass assignment: status', { ...VALID, status: 'closed' }], ['mass assignment: account_id', { ...VALID, account_id: ACC2 }], ['mass assignment: patient_id', { ...VALID, patient_id: PAT2 }],
    ['mass assignment: version', { ...VALID, version: 9 }], ['body is not an object', 'hello'], ['body missing', undefined], ['body is null', null], ['body is an array', [VALID]],
  ];
  for (const [name, body] of bad) {
    it(`bad input is common.validation_failed and writes nothing: ${name}`, async () => {
      const w = makeWorld();
      const call = name === 'body missing' ? run(w, 'createMyEnquiry', 'patient', {}) : myCreate(w, body);
      expect(await code(call)).toBe('common.validation_failed');
      expect(w.writes()).toEqual([]);
    });
  }

  it('feature switched off (enquiries_enabled = false) -> common.feature_disabled; nothing is written', async () => {
    const w = makeWorld({ enabled: false });
    expect(await code(myCreate(w))).toBe('common.feature_disabled');
    expect(w.writes()).toEqual([]);
  });

  it('about a profile: an ACTIVE link of the caller stores patient_id and returns profile_id = the link id (never the patient id)', async () => {
    const w = makeWorld();
    const out: any = await myCreate(w, { ...VALID, profile_id: LINK1 });
    expect(out.status).toBe(201);
    expect(out.body.profile_id).toBe(LINK1);
    expect(w.enquiry(out.body.id)!['patient_id']).toBe(PAT1);
    expect(JSON.stringify(out.body)).not.toContain(PAT1);
  });

  it('about a profile that is not the caller\'s ACTIVE link (another account\'s link, a suspended link, a random id, another tenant\'s link) -> common.not_found, nothing written', async () => {
    const w = makeWorld();
    for (const profile_id of [ID(0xc4), ID(0xc3), ID(0xdead), ID(0xcb)]) {
      expect(await code(myCreate(w, { ...VALID, profile_id })), profile_id).toBe('common.not_found');
    }
    expect(w.writes()).toEqual([]);
  });

  it('open-limit: with 5 open enquiries the 6th is 409 engagement.enquiry_invalid_transition and writes nothing; closed ones and other accounts\' open ones do not count', async () => {
    const w = makeWorld({ seed: ({ tables }) => { // ACC1: E1 open + 4 more open = 5 open; E2 answered, E3 closed stay; ACC2 has 6 open of its own
      for (let i = 0; i < 4; i++) tables['enquiries']!.push({ ...tables['enquiries']![0]!, id: EQ(20 + i) });
      for (let i = 0; i < 6; i++) tables['enquiries']!.push({ ...tables['enquiries']![3]!, id: EQ(30 + i) });
    } });
    const before = w.tables['enquiries']!.length;
    expect(await code(myCreate(w))).toBe('engagement.enquiry_invalid_transition');
    expect(w.writes()).toEqual([]);
    expect(w.tables['enquiries']).toHaveLength(before);
    // closing one frees a slot (counts only open ones)
    expect((await stClose(w, EQ(20), 3) as any).body.status).toBe('closed');
    expect((await myCreate(w) as any).status).toBe(201);
    // another account with 6 open is not blocked by ACC1, and ACC1's 5 do not block it
    expect(await code(myCreate(w, VALID, { account: ACC2 }))).toBe('engagement.enquiry_invalid_transition'); // ACC2 has 7 open (E4 + 6)
    const w2 = makeWorld();
    expect((await myCreate(w2, VALID, { account: ACC2 }) as any).status).toBe(201);
  });

  it('open-limit under concurrency: 6 simultaneous creates with 3 open -> exactly 2 succeed, at most 5 stay open', async () => {
    const w = makeWorld({ seed: ({ tables }) => {
      const e2 = tables['enquiries']!.find((e) => e['id'] === EQ(2))!; e2['status'] = 'closed'; e2['closed_at'] = '2026-11-03T10:00:00.000Z'; // ACC1: only E1 open ...
      for (let i = 0; i < 2; i++) tables['enquiries']!.push({ ...tables['enquiries']![0]!, id: EQ(20 + i) }); // ... + 2 = 3 open
    } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => myCreate(w, { ...VALID, subject: `race ${i}` })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed.map((r) => r.reason?.code)).toEqual(Array(4).fill('engagement.enquiry_invalid_transition'));
    expect(ok).toHaveLength(2);
    expect(w.tables['enquiries']!.filter((e) => e['account_id'] === ACC1 && e['status'] === 'open')).toHaveLength(5);
  });

  it('a hostile subject / message is stored as data: it appears only in parameters, never in statement text, and comes back verbatim', async () => {
    const w = makeWorld();
    const evil = `x'); DROP TABLE engagement.enquiries; -- ${'<script>alert(1)</script>'}`;
    const out: any = await myCreate(w, { ...VALID, subject: evil, message: evil });
    expect(out.body.subject).toBe(evil);
    expect(out.body.messages[0].body).toBe(evil);
    for (const c of w.stmts) expect(c.text, c.text).not.toContain('DROP TABLE');
    expect(w.tables['enquiries']!.length).toBe(6);
  });
});

describe('E48 listMyEnquiries / E50 getMyEnquiry — only the caller\'s own (US-EN-18.3)', () => {
  it('returns 200 {data, page:{limit}} newest first (last_message_at DESC), no-store, reads only; EnquirySummary items without messages', async () => {
    const w = makeWorld();
    const out: any = await myList(w);
    expect(out.status).toBe(200);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(out.body.page.limit).toBe(50);
    expect(idsOf(out)).toEqual([EQ(1), EQ(2), EQ(3)]);
    for (const e of out.body.data) {
      expect(schemaErrors('EnquirySummary', e), JSON.stringify(e)).toEqual([]);
      for (const k of ['messages', 'patient_id', 'account_id', 'tenant_id', 'body']) expect(e, k).not.toHaveProperty(k);
    }
    expect(out.body.data[0]).toMatchObject({ status: 'open', profile_id: LINK1, version: 3 });
    expect(out.body.data[1]).not.toHaveProperty('profile_id');
    expect(w.writes()).toEqual([]);
  });

  it('another account of the same tenant and another tenant see none of them', async () => {
    const w = makeWorld();
    expect(idsOf(await myList(w, {}, { account: ACC2 }))).toEqual([EQ(4)]);
    expect(idsOf(await myList(w, {}, { tenant: TB, account: ACC_B }))).toEqual([EQ(5)]);
  });

  it('paging walks every row exactly once with an opaque cursor; the last page has no next_cursor; limit 200 allowed', async () => {
    const w = makeWorld();
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const out: any = await myList(w, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(out.body.page.limit).toBe(2);
      seen.push(...idsOf(out));
      cursor = out.body.page.next_cursor;
      if (cursor === undefined) break;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    }
    expect(seen).toEqual([EQ(1), EQ(2), EQ(3)]);
    expect(cursor).toBeUndefined();
    expect((await myList(w, { limit: 200 }) as any).body.page.next_cursor).toBeUndefined();
  });

  it('a cursor never leaks rows of another account: a cursor from account 1 used by account 2 returns only account 2 rows', async () => {
    const w = makeWorld();
    const first: any = await myList(w, { limit: 1 });
    const out: any = await myList(w, { limit: 50, cursor: first.body.page.next_cursor }, { account: ACC2 });
    expect(idsOf(out).every((id: string) => id === EQ(4))).toBe(true);
  });

  it('bad input is common.validation_failed: limit 0 / 201 / abc / 1.5, malformed cursor', async () => {
    const w = makeWorld();
    for (const q of [{ limit: 0 }, { limit: 201 }, { limit: 'abc' }, { limit: 1.5 }, { cursor: 'not base64!!' }, { cursor: 'x'.repeat(513) }]) {
      expect(await code(myList(w, q)), JSON.stringify(q)).toBe('common.validation_failed');
    }
  });

  it('E50 returns the thread: Enquiry schema, messages oldest first with author_kind, version, no patient_id', async () => {
    const w = makeWorld();
    const out: any = await myGet(w, EQ(2));
    expect(out.status).toBe(200);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(schemaErrors('Enquiry', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ id: EQ(2), status: 'answered', version: 4, category_code: 'booking', subject: 'Synthetic subject two' });
    expect(out.body.messages.map((m: any) => [m.author_kind, m.body])).toEqual([['patient', 'Synthetic patient question two'], ['staff', 'Synthetic lab answer two']]);
    expect(out.body).not.toHaveProperty('patient_id');
    expect((await myGet(w, EQ(1)) as any).body.profile_id).toBe(LINK1);
    expect(w.writes()).toEqual([]);
  });

  it('PROBE: A2 reads A1\'s enquiry -> 404 common.not_found (same as an id that does not exist); other tenant too; no statement writes', async () => {
    const w = makeWorld();
    for (const id of [EQ(1), EQ(2), EQ(3)]) expect(await code(myGet(w, id, { account: ACC2 })), id).toBe('common.not_found');
    expect(await code(myGet(w, EQ(1), { tenant: TB, account: ACC_B }))).toBe('common.not_found');
    expect(await code(myGet(w, EQ(5)))).toBe('common.not_found');
    expect(await code(myGet(w, ID(0xbeef)))).toBe('common.not_found');
    expect(w.writes()).toEqual([]);
  });

  it('PROBE: a malformed enquiry_id is refused (validation_failed or not_found) without writing', async () => {
    const w = makeWorld();
    for (const id of ['not-a-uuid', "1' OR '1'='1", '']) expect(['common.validation_failed', 'common.not_found']).toContain(await code(myGet(w, id)));
    expect(w.writes()).toEqual([]);
  });
});

describe('E51 replyMyEnquiry (US-EN-18.4): transitions', () => {
  it('answered -> open: the message is appended, status open, version + 1, last_message_at = now', async () => {
    const w = makeWorld();
    const out: any = await myReply(w, EQ(2), 'Synthetic follow-up', 4);
    expect(out.status).toBe(200);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(schemaErrors('Enquiry', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ id: EQ(2), status: 'open', version: 5, last_message_at: NOW });
    expect(out.body.messages.map((m: any) => m.author_kind)).toEqual(['patient', 'staff', 'patient']);
    expect(out.body.messages[2]).toEqual({ author_kind: 'patient', body: 'Synthetic follow-up', created_at: NOW });
    expect(w.enquiry(EQ(2))).toMatchObject({ status: 'open', version: 5, closed_at: null, updated_by: MEMBERSHIP[ACC1] });
    expect(iso(w.enquiry(EQ(2))!['last_message_at'])).toBe(NOW);
    const added = w.messages(EQ(2)).find((m) => m['body'] === 'Synthetic follow-up')!;
    expect(added).toMatchObject({ author_kind: 'patient', account_id: ACC1, created_by: MEMBERSHIP[ACC1] });
    expect(w.tables['notifications']).toEqual([]);
  });

  it('open -> open: a second message on an open enquiry is appended; status stays open', async () => {
    const w = makeWorld();
    const out: any = await myReply(w, EQ(1), 'Synthetic second message', 3);
    expect(out.body).toMatchObject({ status: 'open', version: 4 });
    expect(out.body.messages).toHaveLength(2);
  });

  it('PROBE closed: reply -> 409 engagement.enquiry_invalid_transition; nothing written; the thread is unchanged', async () => {
    const w = makeWorld();
    const before = JSON.stringify([w.enquiry(EQ(3)), w.messages(EQ(3))]);
    expect(await code(myReply(w, EQ(3), 'Synthetic late reply', 5))).toBe('engagement.enquiry_invalid_transition');
    expect(w.writes()).toEqual([]);
    expect(JSON.stringify([w.enquiry(EQ(3)), w.messages(EQ(3))])).toBe(before);
  });

  it('If-Match: absent -> common.precondition_required; malformed -> common.validation_failed; stale -> common.version_conflict; all write nothing', async () => {
    const w = makeWorld();
    expect(await code(myReply(w, EQ(1), 'x', undefined))).toBe('common.precondition_required');
    for (const v of ['abc', '0', '-1', '3.5', '']) expect(await code(myReply(w, EQ(1), 'x', v)), v).toBe('common.validation_failed');
    expect(await code(run(w, 'replyMyEnquiry', 'patient', { params: { enquiry_id: EQ(1) }, body: { message: 'x' }, headers: { 'if-match': '3' } }))).toBe('common.validation_failed'); // unquoted
    expect(await code(myReply(w, EQ(1), 'x', 2))).toBe('common.version_conflict');
    expect(await code(myReply(w, EQ(1), 'x', 4))).toBe('common.version_conflict');
    expect(w.writes()).toEqual([]);
  });

  it('bad message is common.validation_failed: empty / 2001 / not a string / missing / extra property (author_kind, status) — nothing written; 2000 is fine', async () => {
    const w = makeWorld();
    for (const message of ['', 'a'.repeat(2001), 7, null, undefined]) expect(await code(myReply(w, EQ(1), message, 3)), String(message)).toBe('common.validation_failed');
    for (const extra of [{ author_kind: 'staff' }, { status: 'closed' }, { account_id: ACC2 }]) {
      expect(await code(run(w, 'replyMyEnquiry', 'patient', { params: { enquiry_id: EQ(1) }, body: { message: 'x', ...extra }, headers: ifm(3) })), JSON.stringify(extra)).toBe('common.validation_failed');
    }
    expect(await code(run(w, 'replyMyEnquiry', 'patient', { params: { enquiry_id: EQ(1) }, body: undefined, headers: ifm(3) }))).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]);
    expect((await myReply(w, EQ(1), 'a'.repeat(2000), 3) as any).status).toBe(200);
  });

  it('PROBE: A2 replies into A1\'s enquiry (even with the right version), another tenant, unknown id -> 404 common.not_found; nothing written', async () => {
    const w = makeWorld();
    expect(await code(myReply(w, EQ(1), 'intruder', 3, { account: ACC2 }))).toBe('common.not_found');
    expect(await code(myReply(w, EQ(2), 'intruder', 4, { account: ACC2 }))).toBe('common.not_found');
    expect(await code(myReply(w, EQ(1), 'intruder', 3, { tenant: TB, account: ACC_B }))).toBe('common.not_found');
    expect(await code(myReply(w, ID(0xbeef), 'x', 1))).toBe('common.not_found');
    expect(w.writes()).toEqual([]);
    expect(w.messages(EQ(1))).toHaveLength(1);
  });

  it('two simultaneous replies with the same If-Match: exactly one wins, the other is common.version_conflict; one message added, version + 1 only', async () => {
    const w = makeWorld();
    const results = await Promise.allSettled([myReply(w, EQ(2), 'racer A', 4), myReply(w, EQ(2), 'racer B', 4)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('common.version_conflict');
    expect(w.messages(EQ(2))).toHaveLength(3);
    expect(w.enquiry(EQ(2))).toMatchObject({ status: 'open', version: 5 });
  });
});

describe('N1 listEnquiries / N2 getEnquiry — staff, tenant-wide (02-TRD §4.13)', () => {
  it('N1 lists every enquiry of the tenant (all accounts) newest first as EnquirySummary; never another tenant\'s; reads only', async () => {
    const w = makeWorld();
    const out: any = await stList(w);
    expect(out.status).toBe(200);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(idsOf(out)).toEqual([EQ(4), EQ(1), EQ(2), EQ(3)]);
    for (const e of out.body.data) { expect(schemaErrors('EnquirySummary', e), JSON.stringify(e)).toEqual([]); expect(e).not.toHaveProperty('messages'); }
    expect(out.body.page.limit).toBe(50);
    expect(idsOf(await stList(w, {}, { tenant: TB }))).toEqual([EQ(5)]);
    expect(w.writes()).toEqual([]);
  });

  it('filters: status, category_code, both; sort=-last_message_at accepted; unknown status / sort / malformed category -> common.validation_failed', async () => {
    const w = makeWorld();
    expect(idsOf(await stList(w, { status: 'open' }))).toEqual([EQ(4), EQ(1)]);
    expect(idsOf(await stList(w, { status: 'answered' }))).toEqual([EQ(2)]);
    expect(idsOf(await stList(w, { status: 'closed' }))).toEqual([EQ(3)]);
    expect(idsOf(await stList(w, { category_code: 'booking' }))).toEqual([EQ(2)]);
    expect(idsOf(await stList(w, { status: 'open', category_code: 'report' }))).toEqual([EQ(1)]);
    expect(idsOf(await stList(w, { status: 'closed', category_code: 'report' }))).toEqual([]);
    expect(idsOf(await stList(w, { sort: '-last_message_at' }))).toEqual([EQ(4), EQ(1), EQ(2), EQ(3)]);
    for (const q of [{ status: 'pending' }, { status: "open' OR '1'='1" }, { sort: 'subject' }, { category_code: 'Bad Code' }, { limit: 0 }, { limit: 201 }, { cursor: '!!!' }]) {
      expect(await code(stList(w, q)), JSON.stringify(q)).toBe('common.validation_failed');
    }
  });

  it('paging: limit + opaque cursor walk every row exactly once, including rows with the same last_message_at', async () => {
    const w = makeWorld({ seed: ({ tables }) => { tables['enquiries']!.push({ ...tables['enquiries']![0]!, id: EQ(9) }); } }); // same last_message_at as E1
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 8; i++) {
      const out: any = await stList(w, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...idsOf(out));
      cursor = out.body.page.next_cursor;
      if (cursor === undefined) break;
    }
    expect([...seen].sort()).toEqual([EQ(1), EQ(2), EQ(3), EQ(4), EQ(9)].sort());
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeUndefined();
  });

  it('N2 returns the StaffEnquiry: messages oldest first, patient_id when the enquiry is about a profile, none otherwise; another tenant / unknown id -> 404', async () => {
    const w = makeWorld();
    const one: any = await stGet(w, EQ(1));
    expect(one.status).toBe(200);
    expect(schemaErrors('StaffEnquiry', one.body)).toEqual([]);
    expect(one.body).toMatchObject({ id: EQ(1), status: 'open', patient_id: PAT1, version: 3 });
    const two: any = await stGet(w, EQ(2));
    expect(two.body).not.toHaveProperty('patient_id');
    expect(two.body.messages.map((m: any) => m.author_kind)).toEqual(['patient', 'staff']);
    expect(await code(stGet(w, EQ(5)))).toBe('common.not_found');
    expect(await code(stGet(w, EQ(1), { tenant: TB }))).toBe('common.not_found');
    expect(await code(stGet(w, ID(0xbeef)))).toBe('common.not_found');
    expect(w.writes()).toEqual([]);
  });
});

describe('N3 replyEnquiry (US-EN-18.2): transitions, in-app notification, no text outside the thread', () => {
  it('open -> answered: staff message appended, version + 1, last_message_at = now; StaffEnquiry; no-store', async () => {
    const w = makeWorld();
    const out: any = await stReply(w, EQ(1), 'Synthetic lab reply', 3);
    expect(out.status).toBe(200);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(schemaErrors('StaffEnquiry', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ id: EQ(1), status: 'answered', version: 4, last_message_at: NOW, patient_id: PAT1 });
    expect(out.body.messages.at(-1)).toEqual({ author_kind: 'staff', body: 'Synthetic lab reply', created_at: NOW });
    expect(w.enquiry(EQ(1))).toMatchObject({ status: 'answered', version: 4, closed_at: null, updated_by: STAFF });
    const added = w.messages(EQ(1)).find((m) => m['body'] === 'Synthetic lab reply')!;
    expect(added).toMatchObject({ account_id: ACC1, author_kind: 'staff', created_by: STAFF });
    expect([STAFF, MEMBERSHIP[ACC1]]).toContain(added['author_id']);
  });

  it('answered -> answered: a further staff reply is appended and notified; status stays answered', async () => {
    const w = makeWorld();
    const out: any = await stReply(w, EQ(2), 'Synthetic second lab reply', 4);
    expect(out.body).toMatchObject({ status: 'answered', version: 5 });
    expect(out.body.messages).toHaveLength(3);
    expect(w.tables['notifications']).toHaveLength(1);
  });

  it('the patient gets exactly one in-app notification {kind enquiry_reply, entity enquiry:<id>, own account, the enquiry\'s patient}; it holds no text and no SMS / port / other table is written', async () => {
    const w = makeWorld();
    const SECRET = 'Synthetic-reply-text-4711';
    await stReply(w, EQ(1), SECRET, 3);
    const n = w.tables['notifications']!;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ tenant_id: w.enquiry(EQ(1))!['tenant_id'], account_id: ACC1, patient_id: PAT1, kind: 'enquiry_reply', entity_type: 'enquiry', entity_id: EQ(1), created_by: STAFF, read_at: null });
    expect(JSON.stringify(n)).not.toContain(SECRET);
    const writes = w.writes().filter((c) => !/^\s*(update\s+engagement\.enquiries|insert\s+into\s+engagement\.(enquiry_messages|notifications))\b/i.test(c.text.replace(/\s+/g, ' ')));
    expect(writes.map((c) => c.text)).toEqual([]);
    for (const c of w.stmts) {
      const holdsText = JSON.stringify(c.values).includes(SECRET) || c.text.includes(SECRET);
      expect(holdsText, c.text).toBe(/^\s*insert\s+into\s+(engagement\.)?enquiry_messages\b/i.test(c.text));
      expect(c.text).not.toContain(SECRET);
    }
    expect(w.portCalls).toEqual([]); // no SMS / messaging / outbox port call at all
    // the enquiry's patient link is the profile the patient sees: the notification points at the enquiry of the account
    expect(n[0]!['patient_id']).toBe(PAT1);
  });

  it('a reply to an enquiry without a profile still notifies the account (patient_id null)', async () => {
    const w = makeWorld();
    await stReply(w, EQ(2), 'Synthetic', 4);
    expect(w.tables['notifications']![0]).toMatchObject({ account_id: ACC1, patient_id: null, kind: 'enquiry_reply', entity_type: 'enquiry', entity_id: EQ(2) });
  });

  it('PROBE closed: staff reply -> 409 engagement.enquiry_invalid_transition; nothing written, nobody notified', async () => {
    const w = makeWorld();
    expect(await code(stReply(w, EQ(3), 'Synthetic', 5))).toBe('engagement.enquiry_invalid_transition');
    expect(w.writes()).toEqual([]);
    expect(w.tables['notifications']).toEqual([]);
  });

  it('If-Match: absent -> 428 common.precondition_required; malformed -> validation_failed; stale -> common.version_conflict; message bad -> validation_failed; nothing written', async () => {
    const w = makeWorld();
    expect(await code(stReply(w, EQ(1), 'x', undefined))).toBe('common.precondition_required');
    expect(await code(stReply(w, EQ(1), 'x', 'abc'))).toBe('common.validation_failed');
    expect(await code(stReply(w, EQ(1), 'x', 2))).toBe('common.version_conflict');
    for (const m of ['', 'a'.repeat(2001), 7, undefined]) expect(await code(stReply(w, EQ(1), m, 3)), String(m)).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]);
    expect(w.tables['notifications']).toEqual([]);
  });

  it('PROBE: another tenant\'s staff cannot reply into this tenant\'s enquiry (404, nothing written); a tenant-B reply to tenant-B\'s own works', async () => {
    const w = makeWorld();
    expect(await code(stReply(w, EQ(1), 'x', 3, { tenant: TB }))).toBe('common.not_found');
    expect(await code(stReply(w, EQ(5), 'x', 1))).toBe('common.not_found');
    expect(w.writes()).toEqual([]);
    expect((await stReply(w, EQ(5), 'Synthetic', 1, { tenant: TB }) as any).body.status).toBe('answered');
    expect(w.tables['notifications']![0]).toMatchObject({ tenant_id: TB, account_id: ACC_B });
  });

  it('staff reply and patient reply race on the same version: exactly one wins, the other gets common.version_conflict', async () => {
    const w = makeWorld();
    const results = await Promise.allSettled([stReply(w, EQ(1), 'lab', 3), myReply(w, EQ(1), 'patient', 3)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('common.version_conflict');
    expect(w.enquiry(EQ(1))!['version']).toBe(4);
    expect(w.messages(EQ(1))).toHaveLength(2);
    expect(w.tables['notifications']!.length).toBe(w.enquiry(EQ(1))!['status'] === 'answered' ? 1 : 0); // a notification only for a staff reply that was stored
  });
});

describe('N4 closeEnquiry (transitions)', () => {
  it('open -> closed and answered -> closed: closed_at = now, version + 1, no message added, StaffEnquiry', async () => {
    const w = makeWorld();
    for (const [id, v] of [[EQ(1), 3], [EQ(2), 4]] as const) {
      const n = w.messages(id).length;
      const out: any = await stClose(w, id, v);
      expect(out.status).toBe(200);
      expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
      expect(schemaErrors('StaffEnquiry', out.body)).toEqual([]);
      expect(out.body).toMatchObject({ id, status: 'closed', version: v + 1 });
      expect(iso(w.enquiry(id)!['closed_at'])).toBe(NOW);
      expect(w.messages(id)).toHaveLength(n);
    }
    expect(w.tables['notifications']).toEqual([]);
  });

  it('closed -> closed is 409 engagement.enquiry_invalid_transition and changes nothing (the same code as a closed reply)', async () => {
    const w = makeWorld();
    expect(await code(stClose(w, EQ(3), 5))).toBe('engagement.enquiry_invalid_transition');
    expect(w.writes()).toEqual([]);
    expect(w.enquiry(EQ(3))).toMatchObject({ status: 'closed', version: 5 });
  });

  it('If-Match: absent -> common.precondition_required; malformed -> validation_failed; stale -> common.version_conflict; unknown / other-tenant id -> 404; nothing written', async () => {
    const w = makeWorld();
    expect(await code(stClose(w, EQ(1), undefined))).toBe('common.precondition_required');
    expect(await code(stClose(w, EQ(1), 'abc'))).toBe('common.validation_failed');
    expect(await code(stClose(w, EQ(1), 9))).toBe('common.version_conflict');
    expect(await code(stClose(w, ID(0xbeef), 1))).toBe('common.not_found');
    expect(await code(stClose(w, EQ(1), 3, { tenant: TB }))).toBe('common.not_found');
    expect(await code(stClose(w, EQ(5), 1))).toBe('common.not_found');
    expect(w.writes()).toEqual([]);
    expect(w.enquiry(EQ(1))!['status']).toBe('open');
  });

  it('after the close the patient can still read the thread (E50) but a reply is 409 (US-EN-18.4), and the open-limit slot is free again', async () => {
    const w = makeWorld();
    await stClose(w, EQ(1), 3);
    expect((await myGet(w, EQ(1)) as any).body.status).toBe('closed');
    expect(await code(myReply(w, EQ(1), 'too late', 4))).toBe('engagement.enquiry_invalid_transition');
    expect(await code(stReply(w, EQ(1), 'too late', 4))).toBe('engagement.enquiry_invalid_transition');
  });

  it('two simultaneous closes: one wins, the other is version_conflict or invalid_transition; the row ends closed at version + 1', async () => {
    const w = makeWorld();
    const results = await Promise.allSettled([stClose(w, EQ(1), 3), stClose(w, EQ(1), 3)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(['common.version_conflict', 'engagement.enquiry_invalid_transition']).toContain((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code);
    expect(w.enquiry(EQ(1))).toMatchObject({ status: 'closed', version: 4 });
  });
});

describe('P3 free text is never logged, never audited, never a metric label, never in a notification (07-SECURITY §3, TRD §13)', () => {
  it('after every operation: subject / message / reply text appear in no log line, audit entry, metric call or port call', async () => {
    const w = makeWorld();
    const S = 'SUBJ-private-8841', M = 'MSG-private-8842', R = 'REPLY-private-8843', F = 'FOLLOW-private-8844';
    const made: any = await myCreate(w, { category_code: 'report', subject: S, message: M, profile_id: LINK1 });
    await myList(w); await myGet(w, made.body.id); await stList(w); await stGet(w, made.body.id);
    await stReply(w, made.body.id, R, 1);
    await myReply(w, made.body.id, F, 2);
    await stClose(w, made.body.id, 3);
    await code(myReply(w, made.body.id, F, 4)); // 409 path
    await code(myGet(w, made.body.id, { account: ACC2 })); // 404 path
    const seen = JSON.stringify([w.logs, w.audit, w.metrics, w.portCalls, w.tables['notifications']]);
    for (const secret of [S, M, R, F]) expect(seen, secret).not.toContain(secret);
    for (const c of w.stmts) for (const secret of [S, M, R, F]) expect(c.text, secret).not.toContain(secret);
  });

  it('a failing statement does not leak the text through the error either (409 / 404 / 400 carry only the code)', async () => {
    const w = makeWorld();
    const M = 'MSG-private-9931';
    for (const mk of [() => myReply(w, EQ(3), M, 5), () => myReply(w, EQ(1), M, 1), () => myReply(w, EQ(1), M, undefined), () => myReply(w, ID(0xbeef), M, 1)]) {
      const e: any = await mk().catch((x: unknown) => x);
      expect(JSON.stringify({ code: e.code, message: e.message, detail: e.detail, details: e.details, title: e.title })).not.toContain(M);
    }
  });
});
