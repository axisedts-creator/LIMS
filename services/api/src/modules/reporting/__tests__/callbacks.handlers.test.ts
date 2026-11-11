// C6-T29 — CB1 POST /v1/reporting/provider-callbacks/{callback_token} (receiveProviderCallback) and CB2 GET (verifyProviderCallback), 02-TRD §6.7.
// ACs: AC-09.3 (valid token => events recorded + ONE apply job; duplicate callback => no second row, no second job); 07-SECURITY T12/A13, REQ-SEC-024/095, test 14 (identical
// responses, byte compare). done_when: "unknown token -> identical 400". LD-49 (b): the DEFINER only records + returns the tenant id; THIS handler enqueues
// reporting.apply_provider_events via ctx.queue.enqueue inside ctx.db.withTenantScope(tx, <returned tenant>, <reporting system actor>, fn). A forged token enqueues NOTHING.
// CR-C6-001: the adapter checks the signature over the RAW body bytes (req.rawBody). Contract assumptions: see callbacks.helpers.ts header.
// Not testable here: nginx 60 r/m/IP + `general` rate tier (core pipeline), the 256 KB raw-body cap (core), real PG/RLS/GUC reset (db/tests), real provider signature schemes (T27/T28).
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { ACC_A, IP, NOW, SYS_OTHER, SYS_REPORTING, TENANT_A, TENANT_B, UUID_RE, cbBody, failure, failureBytes, makeCallbackWorld, sha256hex, sign, type CallbackWorld } from './callbacks.helpers.js';

const APPLY = 'reporting.apply_provider_events';
const REJECTED = { code: 'reporting.callback_rejected', statusCode: 400 };
const ev = (id: string, status = 'delivered', extra: object = {}) => ({ provider_message_id: id, status, occurred_at: '2026-11-07T11:00:00.000Z', ...extra });
const lastDefiner = (w: CallbackWorld) => w.definerCalls.at(-1)!;

describe('fake self-check (passes without the implementation)', () => {
  it('the DEFINER fake follows LD-49 (b): tenant id for a valid token, NULL otherwise, never enqueues; the queue fake enforces the tenant check', async () => {
    const w = makeCallbackWorld(); const ask = async (kind: unknown, h: unknown, e: unknown) => (await w.tx.query('SELECT app.reporting_ingest_provider_callback($1, $2, $3::jsonb)', [kind, h, JSON.stringify(e)])).rows[0].tenant_id;
    expect(await ask('recording', w.hash(w.tok.a.token), [])).toBe(TENANT_A);
    expect(await ask('recording', w.hash(w.tok.b.token), [])).toBe(TENANT_B);
    for (const [k, h, e] of [['recording', w.hash('nope'), []], ['recording', w.hash(w.tok.off.token), []], ['sms_sparrow', w.hash(w.tok.a.token), []], ['recording', w.hash(w.tok.a.token), {}],
      ['recording', Buffer.alloc(31), []], ['recording', w.hash(w.tok.a.token), Array.from({ length: 101 }, () => ({}))]] as const) expect(await ask(k, h, e)).toBeNull();
    await expect(w.ctx().queue.enqueue(w.tx, APPLY, { tenant_id: TENANT_A }, `pe:${TENANT_A}`)).rejects.toThrow('job_tenant_mismatch');          // outside any scope
    await w.ctx().db.withTenantScope(w.tx, TENANT_B, SYS_REPORTING, () => expect(w.ctx().queue.enqueue(w.tx, APPLY, { tenant_id: TENANT_A })).rejects.toThrow('job_tenant_mismatch'));
    expect(w.jobs).toEqual([]);
  });
});

describe('manifest wiring', () => {
  it('CB1 and CB2 are real handlers (not the 501 stub)', async () => {
    const { manifest } = await import('../index.js');
    for (const op of ['receiveProviderCallback', 'verifyProviderCallback']) {
      expect(typeof manifest.handlers[op], op).toBe('function');
      const r: any = await manifest.handlers[op]!({ params: { callback_token: 'x' }, query: {}, headers: {}, body: undefined, rawBody: Buffer.alloc(0) } as any, { operationId: op } as any).catch((e: any) => e);
      expect(r?.status, op).not.toBe(501);
    }
  });
});

describe('AC-09.3 CB1: valid token + valid adapter signature', () => {
  it('stores the events through the DEFINER and answers 200 {}', async () => {
    const w = makeCallbackWorld(); const raw = cbBody([ev('rec-1'), ev('rec-2', 'sent')]);
    const r: any = await w.cb1(w.tok.a.token, raw);
    expect(r.status).toBe(200); expect(r.body).toEqual({});
    expect(w.providerEvents.map((p) => [p['provider_message_id'], p['mapped_status'], p['status_raw']]).sort()).toEqual([['rec-1', 'delivered', 'delivered'], ['rec-2', 'sent', 'sent']]);
    expect(w.providerEvents.every((p) => p['tenant_id'] === TENANT_A && p['channel_account_id'] === ACC_A && p['provider_kind'] === 'recording')).toBe(true);
  });
  it('the DEFINER gets (provider_kind, sha256(path token) as 32 bytes, events with API-generated uuid ids); the plaintext token never reaches SQL', async () => {
    const w = makeCallbackWorld(); await w.cb1(w.tok.a.token, cbBody([ev('rec-1'), ev('rec-2')]));
    const d = lastDefiner(w); expect(d.kind).toBe('recording'); expect(Buffer.from(d.hash as Uint8Array).equals(w.hash(w.tok.a.token))).toBe(true); expect((d.hash as Uint8Array).length).toBe(32);
    expect(d.events).toHaveLength(2); for (const e of d.events) { expect(e.id).toMatch(UUID_RE); expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['id', 'mapped_status', 'provider_message_id', 'status_raw'])); }
    expect(new Set(d.events.map((e: any) => e.id)).size).toBe(2);
    expect(JSON.stringify(w.stmts)).not.toContain(w.tok.a.token);
  });
  it('the DEFINER call is the ONLY statement the handler sends (no table access, no set_config, no enqueue_job SQL, no JWT claims)', async () => {
    const w = makeCallbackWorld(); await w.cb1(w.tok.a.token, cbBody([ev('rec-1')]));
    expect(w.stmts).toHaveLength(1); expect(w.stmts[0]!.text).toMatch(/app\.reporting_ingest_provider_callback\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3(::jsonb)?\s*\)/i);
    expect(JSON.stringify(w.stmts)).not.toMatch(/enqueue_job|set_config|request\.jwt|reporting\.(provider_events|channel_accounts)/i);
  });
  it('LD-49 (b): enqueues EXACTLY ONE reporting.apply_provider_events { tenant_id } inside withTenantScope(<returned tenant>, <reporting system actor>), job key pe:<tenant>', async () => {
    const w = makeCallbackWorld(); await w.cb1(w.tok.a.token, cbBody([ev('rec-1'), ev('rec-2', 'sent')]));
    expect(w.jobs).toHaveLength(1); const j = w.jobs[0]!;
    expect(j.identifier).toBe(APPLY); expect(j.payload).toEqual({ tenant_id: TENANT_A }); expect(j.jobKey).toBe(`pe:${TENANT_A}`);
    expect(j.scope).toEqual({ tenantId: TENANT_A, actorId: SYS_REPORTING });
    expect(w.scopeCalls).toEqual([{ tenantId: TENANT_A, actorId: SYS_REPORTING, hadTx: true }]);
    expect(w.scopeCalls[0]!.actorId).not.toBe(SYS_OTHER);
  });
  it('the tenant comes from the DEFINER result, never from the body: a body that names tenant B still enqueues under tenant A', async () => {
    const w = makeCallbackWorld(); await w.cb1(w.tok.a.token, cbBody([ev('rec-1', 'delivered', { tenant_id: TENANT_B })]));
    expect(w.jobs.map((j) => j.payload)).toEqual([{ tenant_id: TENANT_A }]); expect(w.scopeCalls.map((s) => s.tenantId)).toEqual([TENANT_A]);
  });
  it('tenant B\'s token enqueues under tenant B (two tenants never cross)', async () => {
    const w = makeCallbackWorld(); await w.cb1(w.tok.a.token, cbBody([ev('a-1')])); await w.cb1(w.tok.b.token, cbBody([ev('b-1')]));
    expect(w.jobs.map((j) => [j.payload.tenant_id, j.scope!.tenantId]).sort()).toEqual([[TENANT_A, TENANT_A], [TENANT_B, TENANT_B]]);
    expect(w.providerEvents.find((p) => p['provider_message_id'] === 'b-1')!['tenant_id']).toBe(TENANT_B);
  });
  it('a duplicate callback (same body twice) creates no second provider_events row and no second pending job (provider_events__dedupe__uq + job key pe:<tenant>)', async () => {
    const w = makeCallbackWorld(); const raw = cbBody([ev('rec-1')]);
    expect((await w.cb1(w.tok.a.token, raw) as any).status).toBe(200); expect((await w.cb1(w.tok.a.token, raw) as any).status).toBe(200);
    expect(w.providerEvents).toHaveLength(1); expect(w.jobs).toHaveLength(1);
  });
  it('the event batch may be non-canonical JSON (whitespace / newlines): the signature is checked over the RAW bytes, parsing happens after', async () => {
    const w = makeCallbackWorld(); const raw = cbBody([ev('rec-1')], true); expect(raw.toString()).not.toBe(JSON.stringify(JSON.parse(raw.toString())));
    expect(((await w.cb1(w.tok.a.token, raw)) as any).status).toBe(200); expect(w.providerEvents).toHaveLength(1);
  });
  it('provider ids are bounded for the DB (message id <= 128, status_raw <= 64) — never more than the DEFINER/CHECK accepts', async () => {
    const w = makeCallbackWorld(); await w.cb1(w.tok.a.token, cbBody([ev('m'.repeat(128), 'delivered')]));
    for (const e of lastDefiner(w).events) { expect(String(e.provider_message_id).length).toBeLessThanOrEqual(128); expect(String(e.status_raw).length).toBeLessThanOrEqual(64); }
  });
  it('never more than 100 events go to the DEFINER in one call (its cap); a larger provider batch is not silently lost', async () => {
    const w = makeCallbackWorld(); const events = Array.from({ length: 150 }, (_, i) => ev(`rec-${i}`));
    const r: any = await w.cb1(w.tok.a.token, cbBody(events)); expect(r.status).toBe(200);
    for (const d of w.definerCalls) expect(d.events.length).toBeLessThanOrEqual(100);
    expect(w.providerEvents).toHaveLength(150);                       // chunks of <= 100: all events stored
    expect(w.jobs).toHaveLength(1);
  });
});

describe('done_when / A13 / T12: unknown token or bad signature -> identical 400 reporting.callback_rejected', () => {
  const good = (w: CallbackWorld) => cbBody([ev('rec-1')]);
  const cases: Array<[string, (w: CallbackWorld) => Promise<unknown>]> = [
    ['unknown token (valid signature)', (w) => w.cb1('A'.repeat(43), good(w))],
    ['unknown token, short', (w) => w.cb1('x', good(w))],
    ['deactivated account token', (w) => w.cb1(w.tok.off.token, good(w))],
    ['token of an account whose provider is not the adapter in use', (w) => w.cb1(w.tok.sms.token, good(w))],
    ['valid token, missing signature header', (w) => w.cb1(w.tok.a.token, good(w), {})],
    ['valid token, wrong signature', (w) => w.cb1(w.tok.a.token, good(w), { 'x-recording-signature': '0'.repeat(64) })],
    ['valid token, signature of a DIFFERENT body (tampered body)', (w) => w.cb1(w.tok.a.token, cbBody([ev('rec-1', 'failed')]), { 'x-recording-signature': sign(good(w)) })],
    ['valid token, signature over the re-serialised JSON instead of the raw bytes', (w) => { const raw = cbBody([ev('rec-1')], true); return w.cb1(w.tok.a.token, raw, { 'x-recording-signature': sha256hex(JSON.stringify(JSON.parse(raw.toString()))) }); }],
    ['valid token + signature, body is not JSON', (w) => { const raw = Buffer.from('not json'); return w.cb1(w.tok.a.token, raw); }],
    ['valid token + signature, unknown status value', (w) => { const raw = cbBody([ev('rec-1', 'bogus')]); return w.cb1(w.tok.a.token, raw); }],
    ['valid token + signature, empty raw body', (w) => w.cb1(w.tok.a.token, Buffer.alloc(0))],
    ['rawBody absent (a handler must not fall back to re-serialising req.body)', (w) => w.call('receiveProviderCallback', { params: { callback_token: w.tok.a.token }, headers: { 'x-recording-signature': sign(good(w)) }, body: { events: [ev('rec-1')] } })],
  ];
  for (const [name, run] of cases) {
    it(`${name}: 400 callback_rejected, no events stored, NOTHING enqueued`, async () => {
      const w = makeCallbackWorld(); const e = await failure(run(w));
      expect(e).toMatchObject(REJECTED); expect(w.providerEvents).toEqual([]); expect(w.jobs).toEqual([]); expect(w.scopeCalls).toEqual([]); expect(w.enqueueAttempts).toEqual([]);
    });
  }
  it('every rejection is byte-identical (unknown token = bad signature = malformed body): same class, code, message, status, detail', async () => {
    const bytes = new Set<string>();
    for (const [, run] of cases) { const w = makeCallbackWorld(); bytes.add(failureBytes(await failure(run(w)))); }
    expect([...bytes]).toHaveLength(1);
    expect(JSON.parse([...bytes][0]!)).toMatchObject({ code: 'reporting.callback_rejected', statusCode: 400 });
  });
  it('the rejection reveals nothing: no token, signature, body fragment or tenant id in the error', async () => {
    const w = makeCallbackWorld(); const e = await failure(w.cb1(w.tok.a.token, good(w), { 'x-recording-signature': 'f'.repeat(64) }));
    const text = failureBytes(e); for (const s of [w.tok.a.token, 'rec-1', 'f'.repeat(64), TENANT_A, 'signature', 'recording']) expect(text, s).not.toContain(s);
  });
  it('a forged token enqueues nothing and opens no tenant scope even when the same world holds a valid tenant (LD-49 test)', async () => {
    const w = makeCallbackWorld(); await w.cb1(w.tok.a.token, good(w)); expect(w.jobs).toHaveLength(1);
    await failure(w.cb1(w.tok.a.token.slice(0, -1) + (w.tok.a.token.endsWith('A') ? 'B' : 'A'), good(w)));
    expect(w.jobs).toHaveLength(1); expect(w.scopeCalls).toHaveLength(1);
  });
  it('timing sanity: an unknown token and a bad signature each cost exactly one DEFINER statement or fewer (no extra lookup that leaks which one failed)', async () => {
    const a = makeCallbackWorld(); await failure(a.cb1('A'.repeat(43), good(a)));
    const b = makeCallbackWorld(); await failure(b.cb1(b.tok.a.token, good(b), { 'x-recording-signature': '0'.repeat(64) }));
    expect(a.stmts.length).toBeLessThanOrEqual(1); expect(b.stmts.length).toBeLessThanOrEqual(1);
  });
});

describe('failure of a dependency', () => {
  it('if the enqueue fails the request fails (500-class, not callback_rejected) and no event row is kept: the provider retries, nothing is half-applied', async () => {
    const w = makeCallbackWorld(); const c = w.ctx(); c.queue = { enqueue: async () => { throw new Error('queue down'); } };
    const e = await failure(w.cb1(w.tok.a.token, cbBody([ev('rec-1')]), undefined, c));
    expect((e as any).code).not.toBe('reporting.callback_rejected'); expect(w.providerEvents).toEqual([]);
  });
  it('if the DEFINER throws (DB down) the request fails as a server error, not as callback_rejected, and nothing is enqueued (the provider retries; core renders the problem+json without internals)', async () => {
    const w = makeCallbackWorld(); const c = w.ctx(); c.tx = { query: async () => { throw Object.assign(new Error('db down'), { code: '57P01' }); } };
    const e = await failure(w.cb1(w.tok.a.token, cbBody([ev('rec-1')]), undefined, c));
    expect((e as any).code).not.toBe('reporting.callback_rejected'); expect(w.jobs).toEqual([]); expect(w.scopeCalls).toEqual([]);
  });
});

describe('logging (02-CV §9.2): no token, signature or provider body in logs', () => {
  it('success and failure paths log neither the path token, the signature, the raw body nor provider message ids', async () => {
    const w = makeCallbackWorld(); const raw = cbBody([ev('rec-secret-id')]);
    await w.cb1(w.tok.a.token, raw); await failure(w.cb1(w.tok.a.token, raw, { 'x-recording-signature': 'e'.repeat(64) })); await failure(w.cb1('Z'.repeat(43), raw));
    const text = w.logs.join('\n'); for (const s of [w.tok.a.token, 'Z'.repeat(43), 'e'.repeat(64), sign(raw), 'rec-secret-id', raw.toString()]) expect(text, s).not.toContain(s);
  });
});

describe('CB2 verifyProviderCallback (provider verification handshake)', () => {
  it('unknown / inactive-account token -> the SAME bytes as the CB1 rejection', async () => {
    const w = makeCallbackWorld(); const post = failureBytes(await failure(w.cb1('A'.repeat(43), cbBody([ev('rec-1')]))));
    for (const t of ['A'.repeat(43), w.tok.off.token, 'x']) expect(failureBytes(await failure(w.cb2(t))), t).toBe(post);
  });
  it('a valid token answers 200 text/plain (<= 1000 chars), and records / enqueues nothing', async () => {
    const w = makeCallbackWorld(); const r: any = await w.cb2(w.tok.a.token, { challenge: 'hello-123' });
    expect(r.status).toBe(200); expect(typeof r.body).toBe('string'); expect(r.body.length).toBeLessThanOrEqual(1000);
    expect(String(r.headers?.['content-type'] ?? '')).toMatch(/^text\/plain/i);
    expect(w.providerEvents).toEqual([]); expect(w.jobs).toEqual([]); expect(w.scopeCalls).toEqual([]);
  });
  it('the token check is the same DEFINER call with an EMPTY events array (it is the only way to resolve a token pre-tenant)', async () => {
    const w = makeCallbackWorld(); await w.cb2(w.tok.a.token);
    expect(w.definerCalls).toHaveLength(1); expect(lastDefiner(w).events).toEqual([]); expect(Buffer.from(lastDefiner(w).hash as Uint8Array).equals(w.hash(w.tok.a.token))).toBe(true);
  });
  it('the response does not echo markup from the query (text/plain, no reflected HTML/script)', async () => {
    const w = makeCallbackWorld(); const r: any = await w.cb2(w.tok.a.token, { challenge: '<script>alert(1)</script>' });
    expect(String(r.body)).not.toMatch(/<script/i);
  });
});

describe('request context', () => {
  it('the handlers need no tenant / actor on the ctx (public, anonymous tx): ctx.tenantId and ctx.actor are undefined and the call still works', async () => {
    const w = makeCallbackWorld(); const c = w.ctx(); expect(c.tenantId).toBeUndefined(); expect(c.actor).toBeUndefined();
    expect(((await w.cb1(w.tok.a.token, cbBody([ev('rec-1')]), undefined, c)) as any).status).toBe(200);
    void IP; void NOW;
  });
});
