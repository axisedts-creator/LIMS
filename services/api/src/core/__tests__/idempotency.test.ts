// T0D-05 — idempotency hook (02-TRD §6.6, 03-APP-FLOW §3.1 K1–K5, AC-0D-4.1…4.6, 08 A25 D-202/D-213, 07-SECURITY AB-14 + data rules).
// Expected API (core/idempotency.ts) — no Fastify types, pipeline-shaped so stages 6 / 10 / 11 of §6.2 can call it:
//   createIdempotency({ db, now?: () => number /* ms epoch, default Date.now */, log?: { info, warn, error } })
//     db = createDb(...) from core/db/tx.ts: the hook opens its own SHORT transactions with db.requestTx({ claims, requestId, clientIp, userAgent, operation }, fn)
//     -> { begin(req), finish(tx, handle, outcome), release(handle) }
//   req = { operation: { module, operationId, context: 'tenant'|'platform'|…, idempotency: 'none'|'optional'|'required' },
//           method, routeTemplate, pathParams, query, body, idempotencyKey: string|undefined, claims: DbClaims, requestId, clientIp, userAgent }
//   begin(req)  [stage 6]  -> { action: 'skip' } | { action: 'proceed', handle } | { action: 'replay', status, body, headers: { 'Idempotent-Replayed': 'true' } }
//        or throws LimsError: 400 common.idempotency_key_required · 422 common.idempotency_key_reused · 409 common.idempotency_in_progress (retryAfterSeconds = 1)
//        a malformed key (not ^[A-Za-z0-9_-]{1,64}$) -> LimsError with status 400, before any SQL.
//   finish(tx, handle, { status, body, commitOnError })  [stage 10, INSIDE the request transaction]
//        status < 400: UPDATE … SET state='completed', response_status, response_body;  status >= 400 && commitOnError: DELETE the in_progress row;
//        status >= 400 otherwise: nothing (the pipeline rolls back).
//   release(handle)  [after a ROLLBACK, separate transaction]: DELETE … WHERE … AND state = 'in_progress'. Never rejects (a failure is logged, never masks the response).
// The pipeline emulation (`serve`) and the in-memory core.idempotency_keys live in idempotency-helpers.ts.
import { describe, expect, it } from 'vitest';
import { createIdempotency } from '../idempotency.js';
import {
  DAY, PATIENT_A, PLATFORM_1, PLATFORM_2, SECOND, TENANT_A, TENANT_B, USER_A, USER_B,
  counting, createIdemEnv, deferred, expectedSha, header, makeReq, platformClaims, platformReq, serve, tenantClaims,
  type Env,
} from './idempotency-helpers.js';

const mk = (servers = 8) => {
  const env = createIdemEnv({ servers });
  const logs: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const mkLog = (level: string) => (obj: unknown, msg?: string) => { logs.push({ level, obj, msg }); };
  const idem = createIdempotency({ db: env.db, now: env.now, log: { info: mkLog('info'), warn: mkLog('warn'), error: mkLog('error') } } as any) as any;
  return { env, idem, logs, go: (req: any, h: any) => serve(env, idem, req, h) };
};
/** Polls until `cond()` holds (no fixed sleeps: Windows timers are coarse). */
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('until(): condition not reached'); await new Promise((r) => setTimeout(r, 2)); }
}
/** A request whose handler never finishes (the process "crashed" after the claim committed). Resolves once the handler is running. */
async function hang(go: (req: any, h: any) => Promise<unknown>, req: any) {
  const never = deferred(); const started = deferred();
  void go(req, async () => { started.resolve(); await never.promise; return { status: 201 }; });
  await started.promise;
  return never;
}
const row = (env: Env, key = 'key-0001', tenant: string | null = TENANT_A, actor = USER_A) => env.row(key, tenant, actor);

describe('AC-0D-4.1 key required / optional / none / malformed', () => {
  it('required + no Idempotency-Key -> 400 common.idempotency_key_required; handler not run; no SQL at all', async () => {
    const { env, go } = mk();
    const h = counting();
    const r = await go(makeReq({ idempotencyKey: undefined }), h);
    expect(r.status).toBe(400);
    expect(r.error.code).toBe('common.idempotency_key_required');
    expect(h.st.runs).toBe(0);
    expect(env.fake.log).toHaveLength(0);
    expect(env.rows()).toHaveLength(0);
  });

  it('an empty header value counts as absent (400)', async () => {
    const { go } = mk();
    const r = await go(makeReq({ idempotencyKey: '' }), counting());
    expect(r.status).toBe(400);
  });

  it('optional + no key -> skip: handler runs, nothing stored, no SQL from the hook', async () => {
    const { env, go } = mk();
    const h = counting();
    const r = await go(makeReq({ idempotencyKey: undefined, operation: { module: 'catalog', operationId: 'createTest', context: 'tenant', idempotency: 'optional' } }), h);
    expect(r.status).toBe(201);
    expect(h.st.runs).toBe(1);
    expect(env.idemStatements()).toHaveLength(0);
    expect(env.rows()).toHaveLength(0);
  });

  it('optional + key present -> the full flow applies (stored, replayed)', async () => {
    const { go } = mk();
    const h = counting();
    const op = { module: 'catalog', operationId: 'createTest', context: 'tenant', idempotency: 'optional' };
    await go(makeReq({ operation: op }), h);
    const again = await go(makeReq({ operation: op }), h);
    expect(again.replayed).toBe(true);
    expect(h.st.runs).toBe(1);
  });

  it("x-idempotency 'none' ignores a supplied key: handler runs every time, nothing stored", async () => {
    const { env, go } = mk();
    const h = counting();
    const op = { module: 'catalog', operationId: 'listTests', context: 'tenant', idempotency: 'none' };
    await go(makeReq({ operation: op }), h);
    await go(makeReq({ operation: op }), h);
    expect(h.st.runs).toBe(2);
    expect(env.idemStatements()).toHaveLength(0);
  });

  it.each([
    ['space', 'a b'], ['65 chars', 'k'.repeat(65)], ['path traversal', '../../etc/passwd'], ['non-ascii', 'ключ'], ['sql', "x'; DROP TABLE core.idempotency_keys;--"],
    ['newline (header splitting)', 'abc\r\nSet-Cookie: x=1'], ['dot', 'a.b'], ['slash', 'a/b'],
  ])('malformed key (%s) -> 400 before any SQL (the DB CHECK would otherwise surface as a 500)', async (_n, key) => {
    const { env, go } = mk();
    const h = counting();
    const r = await go(makeReq({ idempotencyKey: key }), h);
    expect(r.status).toBe(400);
    expect(h.st.runs).toBe(0);
    expect(env.fake.log).toHaveLength(0);
  });

  it.each([['1 char', 'k'], ['64 chars', 'k'.repeat(64)], ['all classes', 'Az09_-Az09_-']])('boundary-valid key (%s) is accepted', async (_n, key) => {
    const { env, go } = mk();
    const r = await go(makeReq({ idempotencyKey: key }), counting());
    expect(r.status).toBe(201);
    expect(env.row(key, TENANT_A, USER_A)?.state).toBe('completed');
  });
});

describe('K1 / K2 / AC-0D-4.2 first request, completion, replay', () => {
  it('K1: an in_progress row exists while the handler runs (tenant+actor from claims, method, route template, sha, 7-day expiry)', async () => {
    const { env, go } = mk();
    const seen = deferred<any>();
    const gate = deferred();
    const p = go(makeReq(), async (_tx: any) => { seen.resolve(row(env)); await gate.promise; return { status: 201, body: { ok: true } }; });
    const inFlight = await seen.promise;
    expect(inFlight).toMatchObject({ tenant_id: TENANT_A, actor_id: USER_A, key: 'key-0001', method: 'POST', route: '/v1/catalog/tests', state: 'in_progress', response_status: null });
    expect(inFlight.response_body).toBeNull();
    expect(Buffer.from(inFlight.request_sha256).equals(expectedSha(makeReq()))).toBe(true);
    expect(inFlight.created_at.getTime()).toBe(env.clock.t);
    expect(inFlight.expires_at.getTime()).toBe(env.clock.t + 7 * DAY);
    gate.resolve();
    expect((await p).status).toBe(201);
  });

  it('the claim commits on its own, before the handler transaction starts (separate short transaction)', async () => {
    const { env, go } = mk();
    await go(makeReq(), counting());
    const claim = env.events.findIndex((e) => e.kind === 'idem' && /^INSERT/i.test(e.text));
    const claimTx = env.events[claim].tx;
    const claimCommit = env.events.findIndex((e) => e.kind === 'commit' && e.tx === claimTx);
    const marker = env.events.findIndex((e) => e.kind === 'marker');
    expect(claimCommit).toBeGreaterThan(claim);
    expect(claimCommit).toBeLessThan(marker);
    expect(env.events[marker].tx).not.toBe(claimTx);
    expect(env.idemStatements()[0].text).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*actor_id\s*,\s*key\s*\)\s*DO NOTHING/i);
  });

  it('K2: completed with status + body; first response is not marked as a replay', async () => {
    const { env, go } = mk();
    const r = await go(makeReq(), counting({ status: 201, body: { id: 't-1', nested: { a: [1, 2, { b: null }] } } }));
    expect(r).toMatchObject({ status: 201, replayed: false });
    expect(header(r, 'Idempotent-Replayed')).toBeUndefined();
    expect(row(env)).toMatchObject({ state: 'completed', response_status: 201, response_body: { id: 't-1', nested: { a: [1, 2, { b: null }] } } });
  });

  it('AC-0D-4.2: same key + same body after completion -> stored status/body + Idempotent-Replayed: true; handler runs once; replay is repeatable', async () => {
    const { env, go } = mk();
    const h = counting({ status: 201, body: { id: 't-1', code: 'CBC' } });
    const first = await go(makeReq(), h);
    for (let i = 0; i < 3; i++) {
      const again = await go(makeReq({ requestId: `0190a000-0000-7000-8000-0000000000${10 + i}` }), h);
      expect(again).toMatchObject({ status: 201, body: first.body, replayed: true, ran: false });
      expect(header(again, 'Idempotent-Replayed')).toBe('true');
    }
    expect(h.st.runs).toBe(1);
    expect(env.markers).toEqual(['run-1']);
    expect(env.rows()).toHaveLength(1);
    // the replay path changed nothing in the table
    expect(row(env)?.created_at.getTime()).toBe(env.clock.t);
  });

  it('replay does not write: no UPDATE / INSERT / DELETE after the first request completed', async () => {
    const { env, go } = mk();
    const h = counting();
    await go(makeReq(), h);
    const before = env.idemStatements().length;
    await go(makeReq(), h);
    const added = env.idemStatements().slice(before).map((e) => e.text);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((t) => /^SELECT/i.test(t) || /ON CONFLICT/i.test(t))).toBe(true);
    expect(added.some((t) => /^(UPDATE|DELETE)/i.test(t))).toBe(false);
  });

  it('request hash is canonical: key order in body / query / path params does not matter -> replay, not 422', async () => {
    const { go } = mk();
    const h = counting();
    await go(makeReq({ body: { b: 1, a: { y: 2, x: [3, { q: 1, p: 2 }] } }, query: { z: '1', y: '2' }, pathParams: { id: 'i', org: 'o' } }), h);
    const again = await go(makeReq({ body: { a: { x: [3, { p: 2, q: 1 }], y: 2 }, b: 1 }, query: { y: '2', z: '1' }, pathParams: { org: 'o', id: 'i' } }), h);
    expect(again.replayed).toBe(true);
    expect(h.st.runs).toBe(1);
  });

  it('request_sha256 = SHA-256 of canonical JSON { method, route_template, path_params, query, body } (32 bytes, bytea)', async () => {
    const { env, go } = mk();
    const req = makeReq({ pathParams: { id: 'i-1' }, query: { dry: 'true' }, body: { z: 1, a: [1, 2] } });
    await go(req, counting());
    const stored = row(env)!;
    expect(stored.request_sha256.byteLength).toBe(32);
    expect(stored.request_sha256.equals(expectedSha(req))).toBe(true);
  });

  it.each([[200], [201], [202], [204], [301], [399]])('status %i (< 400) is stored and replayed', async (status) => {
    const { env, go } = mk();
    const h = counting({ status, body: status === 204 ? undefined : { s: status } });
    const first = await go(makeReq(), h);
    const again = await go(makeReq(), h);
    expect(first.status).toBe(status);
    expect(again).toMatchObject({ status, replayed: true });
    expect(again.body ?? null).toEqual(status === 204 ? null : { s: status });
    expect(h.st.runs).toBe(1);
    expect(row(env)?.response_status).toBe(status);
  });

  it('K2 happens in the SAME transaction as the domain write, before its COMMIT', async () => {
    const { env, go } = mk();
    await go(makeReq(), counting());
    const marker = env.events.find((e) => e.kind === 'marker')!;
    const completed = env.events.find((e) => e.kind === 'idem' && /^UPDATE/i.test(e.text) && /completed/i.test(e.text + JSON.stringify(e.values)))!;
    expect(completed.tx).toBe(marker.tx);
    const commitIdx = env.events.findIndex((e) => e.kind === 'commit' && e.tx === marker.tx);
    expect(env.events.indexOf(completed)).toBeLessThan(commitIdx);
    expect(env.events.indexOf(marker)).toBeLessThan(commitIdx);
  });

  it('K2 atomicity: COMMIT fails -> domain write AND completion are both gone, the key is released, a retry re-runs the handler', async () => {
    const { env, go } = mk();
    const h = counting();
    // armed from inside the handler, so it hits the REQUEST transaction's COMMIT (the claim's COMMIT is already behind us)
    const failing = async (tx: any, c: any) => { const r = await h(tx, c); env.fake.inject(/^COMMIT/i, () => Object.assign(new Error('connection terminated'), { code: '57P01' })); return r; };
    const first = await go(makeReq(), failing);
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(env.markers).toEqual([]);
    expect(row(env)).toBeUndefined(); // neither completed nor stuck in_progress
    const retry = await go(makeReq(), h);
    expect(retry).toMatchObject({ status: 201, replayed: false });
    expect(h.st.runs).toBe(2);
    expect(env.markers).toEqual(['run-2']);
  });

  it('E-3 crash after commit, before the response reached the client: the retry replays (handler not re-run)', async () => {
    const { env, go } = mk();
    const h = counting();
    await go(makeReq(), h); // the response is "lost": the client never sees it
    const retry = await go(makeReq(), h);
    expect(retry).toMatchObject({ status: 201, replayed: true });
    expect(h.st.runs).toBe(1);
    expect(env.markers).toEqual(['run-1']);
  });

  it('a completed row still replays shortly before its 7-day expiry (6 days)', async () => {
    const { env, go } = mk();
    const h = counting();
    await go(makeReq(), h);
    env.advance(6 * DAY);
    expect((await go(makeReq(), h)).replayed).toBe(true);
    expect(h.st.runs).toBe(1);
  });
});

describe('AC-0D-4.3 same key, different request -> 422 common.idempotency_key_reused', () => {
  it.each([
    ['body', { body: { code: 'CBC', name: 'Different' } }],
    ['extra body field', { body: { code: 'CBC', name: 'Complete blood count', extra: 1 } }],
    ['method', { method: 'PUT' }],
    ['route template', { routeTemplate: '/v1/catalog/panels' }],
    ['path param', { pathParams: { id: 'other' } }],
    ['query', { query: { dry: 'true' } }],
  ])('after completion, a different %s -> 422, handler not run, stored row untouched', async (_n, change) => {
    const { env, go } = mk();
    const h = counting({ status: 201, body: { id: 't-1' } });
    await go(makeReq({ pathParams: { id: 'i' } }), h);
    const before = row(env)!;
    const r = await go(makeReq({ pathParams: { id: 'i' }, ...change }), h);
    expect(r.status).toBe(422);
    expect(r.error.code).toBe('common.idempotency_key_reused');
    expect(h.st.runs).toBe(1);
    expect(row(env)).toEqual(before);
  });

  it('while the first request is still running, a different body is 422 (not 409), and the running request is unaffected', async () => {
    const { env, go } = mk();
    const started = deferred(); const gate = deferred();
    const first = go(makeReq(), async () => { started.resolve(); await gate.promise; return { status: 201, body: { ok: 1 } }; });
    await started.promise;
    const other = await go(makeReq({ body: { code: 'XYZ' } }), counting());
    expect(other.status).toBe(422);
    expect(other.error.code).toBe('common.idempotency_key_reused');
    gate.resolve();
    expect((await first).status).toBe(201);
    expect(row(env)?.state).toBe('completed');
  });

  it('after the first attempt FAILED (key released), a different body under the same key is a fresh request, not 422', async () => {
    const { go } = mk();
    const fail = counting({ status: 422, body: { code: 'catalog.test_code_taken' } });
    expect((await go(makeReq(), fail)).status).toBe(422);
    const h = counting();
    const r = await go(makeReq({ body: { code: 'NEW', name: 'Other' } }), h);
    expect(r).toMatchObject({ status: 201, replayed: false });
    expect(h.st.runs).toBe(1);
  });
});

describe('AC-0D-4.4 / K4 in-progress, concurrency, crash takeover', () => {
  it('same key while the first request is running -> 409 common.idempotency_in_progress with Retry-After: 1; handler runs once; then a retry replays', async () => {
    const { go } = mk();
    const started = deferred(); const gate = deferred();
    const h = counting();
    const first = go(makeReq(), async (tx: any, c: any) => { started.resolve(); await gate.promise; return h(tx, c); });
    await started.promise;
    const second = await go(makeReq(), h);
    expect(second.status).toBe(409);
    expect(second.error.code).toBe('common.idempotency_in_progress');
    expect(second.error.retryAfterSeconds).toBe(1);
    expect(header(second, 'Retry-After')).toBe('1');
    expect(h.st.runs).toBe(0);
    gate.resolve();
    expect((await first).status).toBe(201);
    const retry = await go(makeReq(), h);
    expect(retry).toMatchObject({ status: 201, replayed: true });
    expect(h.st.runs).toBe(1);
  });

  it('20 simultaneous identical requests -> exactly one handler run, one 201, the other 19 are 409 in_progress', async () => {
    const { env, go } = mk(12);
    const gate = deferred();
    let runs = 0;
    const handler = async (tx: any) => { runs++; await tx.query('INSERT INTO catalog.marker (v) VALUES ($1)', ['x']); await gate.promise; return { status: 201, body: { ok: 1 } }; };
    let done = 0;
    const all = Array.from({ length: 20 }, () => go(makeReq(), handler).then((r) => { done++; return r; }));
    await until(() => done === 19); // the 19 losers answer while the winner's handler is still running
    gate.resolve();
    const out = await Promise.all(all);
    expect(runs).toBe(1);
    expect(out.filter((r) => r.status === 201 && !r.replayed)).toHaveLength(1);
    expect(out.filter((r) => r.status === 409 || r.replayed)).toHaveLength(19);
    expect(out.filter((r) => r.status === 409).every((r) => r.error.code === 'common.idempotency_in_progress')).toBe(true);
    expect(env.markers).toEqual(['x']);
    expect(env.rows()).toHaveLength(1);
  });

  it('K4 boundary: in_progress for 59.999 s is still 409; at exactly 60 s the key is abandoned and taken over (handler runs again)', async () => {
    const { env, go } = mk();
    const never = await hang(go, makeReq()); // the original process "crashed": its handler never finishes
    env.advance(60 * SECOND - 1);
    const h = counting();
    const early = await go(makeReq(), h);
    expect(early.status).toBe(409);
    expect(h.st.runs).toBe(0);
    env.advance(1);
    const taken = await go(makeReq(), h);
    expect(taken).toMatchObject({ status: 201, replayed: false });
    expect(h.st.runs).toBe(1);
    expect(row(env)).toMatchObject({ state: 'completed', response_status: 201 });
    expect((await go(makeReq(), h)).replayed).toBe(true);
    never.reject(new Error('test cleanup'));
  });

  it('K4: the takeover resets created_at to now() and keeps the row in_progress while the new handler runs (a third caller gets 409 again)', async () => {
    const { env, go } = mk();
    const never = await hang(go, makeReq());
    env.advance(61 * SECOND);
    const started = deferred(); const gate = deferred();
    const second = go(makeReq(), async () => { started.resolve(); await gate.promise; return { status: 201, body: { v: 2 } }; });
    await started.promise;
    expect(row(env)).toMatchObject({ state: 'in_progress' });
    expect(row(env)!.created_at.getTime()).toBe(env.clock.t);
    expect((await go(makeReq(), counting())).status).toBe(409);
    gate.resolve();
    expect((await second).status).toBe(201);
    never.reject(new Error('test cleanup'));
  });

  it('K4 race: two retries hit the same abandoned key at once -> exactly one takes over, the other gets 409', async () => {
    const { env, go } = mk();
    const never = await hang(go, makeReq());
    env.advance(120 * SECOND);
    const gate = deferred();
    let runs = 0;
    const handler = async () => { runs++; await gate.promise; return { status: 201, body: { ok: 1 } }; };
    let done = 0;
    const a = go(makeReq(), handler).then((r) => { done++; return r; }); const b = go(makeReq(), handler).then((r) => { done++; return r; });
    await until(() => done === 1); // the loser answers while the winner's handler is still running
    gate.resolve();
    const out = await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(out.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(out.find((r) => r.status === 409)!.error.code).toBe('common.idempotency_in_progress');
    never.reject(new Error('test cleanup'));
  });

  it('crash simulation: the process dies after the claim committed -> the row stays in_progress (not completed, not deleted); a retry in < 60 s is 409', async () => {
    const { env, go } = mk();
    const never = await hang(go, makeReq());
    env.advance(10 * SECOND);
    expect(row(env)?.state).toBe('in_progress');
    expect((await go(makeReq(), counting())).status).toBe(409);
    expect(row(env)?.state).toBe('in_progress');
    never.reject(new Error('test cleanup'));
  });

  it('the staleness decision never uses a stored status: an abandoned in_progress row is not mistaken for a completed one', async () => {
    const { env, go } = mk();
    const never = await hang(go, makeReq());
    const r = await go(makeReq(), counting());
    expect(r.replayed).toBe(false);
    expect(r.status).toBe(409);
    expect(row(env)?.response_status).toBeNull();
    never.reject(new Error('test cleanup'));
  });
});

describe('AC-0D-4.5 / K3 / D-202 — status >= 400 stores nothing and releases the key', () => {
  it('4xx, rollback path: nothing stored, the handler write rolled back, key released AFTER the rollback in a SEPARATE transaction, retry re-runs the handler', async () => {
    const { env, go } = mk();
    const h = counting((n) => (n === 1 ? { status: 422, body: { code: 'catalog.test_code_taken' } } : { status: 201, body: { id: 't-2' } }));
    const first = await go(makeReq(), h);
    expect(first).toMatchObject({ status: 422, replayed: false });
    expect(env.markers).toEqual([]);
    expect(row(env)).toBeUndefined();
    const marker = env.events.find((e) => e.kind === 'marker')!;
    const rollbackIdx = env.events.findIndex((e) => e.kind === 'rollback' && e.tx === marker.tx);
    const del = env.events.find((e) => e.kind === 'idem' && /^DELETE/i.test(e.text))!;
    expect(rollbackIdx).toBeGreaterThan(-1);
    expect(env.events.indexOf(del)).toBeGreaterThan(rollbackIdx);
    expect(del.tx).not.toBe(marker.tx);
    expect(del.text).toMatch(/state\s*=\s*'in_progress'/i);
    expect(env.idemStatements().some((e) => /^UPDATE/i.test(e.text) && /completed/i.test(e.text + JSON.stringify(e.values)))).toBe(false);
    const retry = await go(makeReq(), h);
    expect(retry).toMatchObject({ status: 201, replayed: false });
    expect(h.st.runs).toBe(2);
    expect(env.markers).toEqual(['run-2']);
  });

  it.each([[400], [401], [403], [404], [409], [422], [429], [500], [502], [503]])('status %i is never stored or replayed; the retry runs the handler again', async (status) => {
    const { env, go } = mk();
    const h = counting((n) => (n === 1 ? { status, body: { code: 'x.y' } } : { status: 200, body: { ok: n } }));
    expect((await go(makeReq(), h)).status).toBe(status);
    expect(row(env)).toBeUndefined();
    const retry = await go(makeReq(), h);
    expect(retry).toMatchObject({ status: 200, body: { ok: 2 }, replayed: false });
    expect(h.st.runs).toBe(2);
  });

  it('boundary: 399 is stored, 400 is not', async () => {
    const { env, go } = mk();
    await go(makeReq({ idempotencyKey: 'k399' }), counting({ status: 399 }));
    await go(makeReq({ idempotencyKey: 'k400' }), counting({ status: 400, body: { code: 'common.validation_failed' } }));
    expect(env.row('k399', TENANT_A, USER_A)?.state).toBe('completed');
    expect(env.row('k400', TENANT_A, USER_A)).toBeUndefined();
  });

  it('4xx with ctx.commitOnError(): other writes survive, the in_progress row is DELETED inside the request transaction before COMMIT, nothing stored', async () => {
    const { env, go } = mk();
    const h = counting((n) => (n === 1 ? { status: 403, body: { code: 'auth.forbidden' } } : { status: 201, body: { ok: 1 } }));
    const handler = async (tx: any, c: any) => { c.commitOnError(); return h(tx, c); };
    const first = await go(makeReq(), handler);
    expect(first.status).toBe(403);
    expect(env.markers).toEqual(['run-1']); // the denied-access / counter write survived
    expect(row(env)).toBeUndefined();
    const marker = env.events.find((e) => e.kind === 'marker')!;
    const del = env.events.find((e) => e.kind === 'idem' && /^DELETE/i.test(e.text))!;
    expect(del.tx).toBe(marker.tx);
    const commitIdx = env.events.findIndex((e) => e.kind === 'commit' && e.tx === marker.tx);
    expect(env.events.indexOf(del)).toBeLessThan(commitIdx);
    expect(env.events.filter((e) => e.kind === 'idem' && /^DELETE/i.test(e.text))).toHaveLength(1); // no second, separate release
    expect(env.idemStatements().some((e) => /^UPDATE/i.test(e.text) && /completed/i.test(e.text + JSON.stringify(e.values)))).toBe(false);
    const retry = await go(makeReq(), h);
    expect(retry).toMatchObject({ status: 201, replayed: false }); // the handler ran again; the 403 was never replayed
    expect(h.st.runs).toBe(2);
  });

  it('5xx with ctx.commitOnError() is released the same way (inside the transaction)', async () => {
    const { env, go } = mk();
    const r = await go(makeReq(), async (tx: any, c: any) => { c.commitOnError(); await tx.query('INSERT INTO catalog.marker (v) VALUES ($1)', ['kept']); return { status: 503, body: { code: 'common.service_unavailable' } }; });
    expect(r.status).toBe(503);
    expect(env.markers).toEqual(['kept']);
    expect(row(env)).toBeUndefined();
  });

  it('commitOnError + COMMIT fails: the in-transaction DELETE is rolled back with it, so the key is released afterwards by the rollback path (never stuck)', async () => {
    const { env, go } = mk();
    const r = await go(makeReq(), async (tx: any, c: any) => {
      c.commitOnError(); await tx.query('INSERT INTO catalog.marker (v) VALUES ($1)', ['m']);
      env.fake.inject(/^COMMIT/i, () => Object.assign(new Error('connection terminated'), { code: '57P01' }));
      return { status: 403, body: {} };
    });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(env.markers).toEqual([]);
    expect(row(env)).toBeUndefined();
    expect((await go(makeReq(), counting())).status).toBe(201);
  });

  it('5xx by exception (handler throws): rolled back, key released, retry runs the handler again', async () => {
    const { env, go } = mk();
    let n = 0;
    const handler = async (tx: any) => { n++; await tx.query('INSERT INTO catalog.marker (v) VALUES ($1)', [`r${n}`]); if (n === 1) throw new Error('boom'); return { status: 201, body: { ok: 1 } }; };
    expect((await go(makeReq(), handler)).status).toBe(500);
    expect(env.markers).toEqual([]);
    expect(row(env)).toBeUndefined();
    expect(await go(makeReq(), handler)).toMatchObject({ status: 201, replayed: false });
    expect(n).toBe(2);
  });

  it('a retried failing request keeps failing the same way every time (nothing cached): wrong-password style 401 x3 runs the handler 3 times', async () => {
    const { go } = mk();
    const h = counting({ status: 401, body: { code: 'auth.invalid_credentials' } });
    for (let i = 0; i < 3; i++) expect((await go(makeReq(), h)).status).toBe(401);
    expect(h.st.runs).toBe(3);
  });

  it('release() deletes only an in_progress row: it cannot remove a completed one (release after completion is a no-op)', async () => {
    const { env, idem } = mk();
    const req = makeReq();
    const d = await idem.begin(req);
    await serve(env, idem, req, counting()).catch(() => undefined); // second begin -> 409 (in progress) — completes nothing
    await env.db.requestTx({ claims: req.claims, requestId: req.requestId, clientIp: req.clientIp, operation: { module: 'catalog', operationId: 'createTest', context: 'tenant' } },
      async (tx: any) => { await idem.finish(tx, d.handle, { status: 201, body: { ok: 1 }, commitOnError: false }); });
    expect(row(env)?.state).toBe('completed');
    await idem.release(d.handle);
    expect(row(env)?.state).toBe('completed');
  });

  it('release() never rejects when the database is down (the original response must not be masked); the key then ages out via K4', async () => {
    const { env, go, logs } = mk();
    env.failIdem(/^DELETE/i, undefined, 5);
    const r = await go(makeReq(), counting({ status: 422, body: { code: 'x.y' } }));
    expect(r.status).toBe(422);
    expect(row(env)?.state).toBe('in_progress'); // not released
    expect((await go(makeReq(), counting())).status).toBe(409);
    env.advance(60 * SECOND);
    const h = counting();
    expect((await go(makeReq(), h)).status).toBe(201);
    expect(h.st.runs).toBe(1);
    expect(logs.some((l) => l.level === 'warn' || l.level === 'error')).toBe(true);
  });

  it('claim failure (database down) -> the request fails closed with a 5xx, the handler never runs unprotected', async () => {
    const { env, go } = mk();
    env.failIdem(/^INSERT/i);
    const h = counting();
    const r = await go(makeReq(), h);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(h.st.runs).toBe(0);
  });
});

describe('K5 retention', () => {
  it('after app.purge_idempotency_keys() removed the expired row the key is reusable, even with a different body', async () => {
    const { env, go } = mk();
    const h = counting();
    await go(makeReq(), h);
    env.advance(7 * DAY + SECOND);
    env.purgeExpired();
    expect(env.rows()).toHaveLength(0);
    const r = await go(makeReq({ body: { code: 'OTHER' } }), h);
    expect(r).toMatchObject({ status: 201, replayed: false });
    expect(h.st.runs).toBe(2);
    expect(row(env)?.expires_at.getTime()).toBe(env.clock.t + 7 * DAY);
  });
});

describe('AC-0D-4.6 / D-213 platform-context keys (tenant_id NULL)', () => {
  it('provisionTenant with a key is stored with tenant_id NULL; same platform actor + key replays; handler runs once', async () => {
    const { env, go } = mk();
    const h = counting({ status: 201, body: { tenant_id: TENANT_B } });
    const first = await go(platformReq(), h);
    expect(first.status).toBe(201);
    const stored = env.row('key-0001', null, PLATFORM_1)!;
    expect(stored).toMatchObject({ tenant_id: null, actor_id: PLATFORM_1, state: 'completed', response_status: 201 });
    const again = await go(platformReq(), h);
    expect(again).toMatchObject({ status: 201, body: { tenant_id: TENANT_B }, replayed: true });
    expect(header(again, 'Idempotent-Replayed')).toBe('true');
    expect(h.st.runs).toBe(1);
    expect(env.rows()).toHaveLength(1);
  });

  it.each([['provisionTenant'], ['openSupportSession'], ['invitePlatformStaff']])('%s: NULL tenant on the row, never a tenant from anywhere else', async (operationId) => {
    const { env, go } = mk();
    await go(platformReq({ operation: { module: 'identity', operationId, context: 'platform', idempotency: 'required' }, body: { tenant_id: TENANT_B } }), counting());
    expect(env.rows().map((r) => r.tenant_id)).toEqual([null]);
  });

  it('a second platform actor with the same key gets its OWN row and runs the handler (never replays the first actor)', async () => {
    const { env, go } = mk();
    const h = counting((n) => ({ status: 201, body: { n } }));
    const a = await go(platformReq(), h);
    const b = await go(platformReq({ claims: platformClaims(PLATFORM_2) }), h);
    expect(a.body).toEqual({ n: 1 });
    expect(b).toMatchObject({ status: 201, body: { n: 2 }, replayed: false });
    expect(env.rows().map((r) => [r.tenant_id, r.actor_id]).sort()).toEqual([[null, PLATFORM_1], [null, PLATFORM_2]]);
    expect((await go(platformReq({ claims: platformClaims(PLATFORM_2) }), h)).replayed).toBe(true);
  });

  it('platform key, different body -> 422 (NULL tenant must not break the lookup)', async () => {
    const { go } = mk();
    const h = counting();
    await go(platformReq(), h);
    const r = await go(platformReq({ body: { code: 'OTHER', name: 'x' } }), h);
    expect(r.status).toBe(422);
    expect(r.error.code).toBe('common.idempotency_key_reused');
  });

  it('platform key in progress -> 409; concurrent identical platform requests run the handler once (UNIQUE NULLS NOT DISTINCT)', async () => {
    const { env, go } = mk(12);
    const gate = deferred();
    let runs = 0;
    const handler = async () => { runs++; await gate.promise; return { status: 201, body: { ok: 1 } }; };
    let done = 0;
    const all = Array.from({ length: 8 }, () => go(platformReq(), handler).then((r) => { done++; return r; }));
    await until(() => done === 7);
    gate.resolve();
    const out = await Promise.all(all);
    expect(runs).toBe(1);
    expect(out.filter((r) => r.status === 409)).toHaveLength(7);
    expect(env.rows()).toHaveLength(1);
  });

  it('K3 for a platform key: a 4xx rolls back and the NULL-tenant row is released (DELETE must match NULL tenant)', async () => {
    const { env, go } = mk();
    const h = counting((n) => (n === 1 ? { status: 409, body: { code: 'identity.tenant_code_taken' } } : { status: 201, body: {} }));
    expect((await go(platformReq(), h)).status).toBe(409);
    expect(env.rows()).toHaveLength(0);
    expect((await go(platformReq(), h)).status).toBe(201);
    // commitOnError flavour
    const h2 = counting({ status: 403, body: {} });
    await go(platformReq({ idempotencyKey: 'key-0002' }), async (tx: any, c: any) => { c.commitOnError(); return h2(tx, c); });
    expect(env.row('key-0002', null, PLATFORM_1)).toBeUndefined();
  });

  it('K4 takeover works for a NULL-tenant key', async () => {
    const { env, go } = mk();
    const never = await hang(go, platformReq());
    env.advance(61 * SECOND);
    const h = counting();
    expect(await go(platformReq(), h)).toMatchObject({ status: 201, replayed: false });
    expect(h.st.runs).toBe(1);
    never.reject(new Error('test cleanup'));
  });

  it('a tenant-context operation by a tenant actor never produces a NULL-tenant row, even if the body names another tenant', async () => {
    const { env, go } = mk();
    await go(makeReq({ body: { tenant_id: TENANT_B, code: 'x' } }), counting());
    expect(env.rows().map((r) => r.tenant_id)).toEqual([TENANT_A]);
  });
});

describe('isolation between actors and tenants (AB-14, 08 A23.3)', () => {
  it('AB-14: another actor of the same tenant using the same key is a new key: handler runs, the first actor’s response is never replayed', async () => {
    const { env, go } = mk();
    const h = counting((n) => ({ status: 201, body: { owner: n } }));
    const a = await go(makeReq(), h);
    const b = await go(makeReq({ claims: tenantClaims({ sub: USER_B }) }), h);
    expect(a.body).toEqual({ owner: 1 });
    expect(b).toMatchObject({ body: { owner: 2 }, replayed: false });
    expect(env.rows().map((r) => r.actor_id).sort()).toEqual([USER_A, USER_B].sort());
  });

  it('same actor id and key in another tenant is a different key', async () => {
    const { env, go } = mk();
    const h = counting();
    await go(makeReq(), h);
    const r = await go(makeReq({ claims: tenantClaims({ tenant_id: TENANT_B }) }), h);
    expect(r.replayed).toBe(false);
    expect(h.st.runs).toBe(2);
    expect(env.rows().map((x) => x.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it('a different actor’s in-progress key does not 409 me and a different actor’s different body does not 422 me', async () => {
    const { go } = mk();
    const started = deferred(); const gate = deferred();
    const first = go(makeReq(), async () => { started.resolve(); await gate.promise; return { status: 201 }; });
    await started.promise;
    const other = await go(makeReq({ claims: tenantClaims({ sub: USER_B }), body: { code: 'Z' } }), counting());
    expect(other.status).toBe(201);
    gate.resolve();
    await first;
  });

  it('non-staff actors (patient) use their own rows with their own tenant claim', async () => {
    const { env, go } = mk();
    const h = counting();
    const claims = tenantClaims({ sub: PATIENT_A, actor_type: 'patient' });
    await go(makeReq({ claims }), h);
    expect((await go(makeReq({ claims }), h)).replayed).toBe(true);
    expect(env.row('key-0001', TENANT_A, PATIENT_A)?.state).toBe('completed');
  });

  it('tenant / actor on the row come from the claims, never from the body, query or path params', async () => {
    const { env, go } = mk();
    await go(makeReq({ body: { tenant_id: TENANT_B, actor_id: USER_B }, query: { tenant_id: TENANT_B }, pathParams: { tenant_id: TENANT_B } }), counting());
    expect(env.rows().map((r) => [r.tenant_id, r.actor_id])).toEqual([[TENANT_A, USER_A]]);
  });

  it('no tenant claim and not a platform operation (public / anonymous): idempotency is never used — nothing stored, no row written', async () => {
    const { env, idem } = mk();
    const req = makeReq({ claims: { sub: USER_A, actor_type: 'user' } });
    try { await idem.begin(req); } catch { /* refusing is acceptable; storing is not */ }
    expect(env.rows()).toHaveLength(0);
  });
});

describe('security / data handling (07-SECURITY §data rules, REQ-SEC)', () => {
  it('every statement on core.idempotency_keys is parameterised: key, tenant, actor and hash never appear in SQL text', async () => {
    const { env, go } = mk();
    const key = 'Secret_Key-12345';
    await go(makeReq({ idempotencyKey: key }), counting({ status: 422, body: {} })); // claim + release
    await go(makeReq({ idempotencyKey: key }), counting()); // claim + complete
    await go(makeReq({ idempotencyKey: key }), counting()); // replay
    for (const e of env.idemStatements()) {
      expect(e.text).not.toContain(key);
      expect(e.text).not.toContain(TENANT_A);
      expect(e.text).not.toContain(USER_A);
    }
  });

  it('stored responses and request bodies are never logged (07 §data rule 1)', async () => {
    const { go, logs } = mk();
    const canary = 'CANARY-PHI-8f3a1c';
    const h = counting({ status: 201, body: { patient: canary } });
    await go(makeReq({ body: { note: canary } }), h);
    await go(makeReq({ body: { note: canary } }), h); // replay
    await go(makeReq({ body: { note: 'other' } }), h); // 422
    await go(makeReq({ idempotencyKey: 'k2', body: { note: canary } }), counting({ status: 500, body: { x: canary } }));
    expect(JSON.stringify(logs)).not.toContain(canary);
  });

  it('the replay path returns no handler-set headers and never re-executes handler code (no side effects on replay)', async () => {
    const { env, go } = mk();
    const h = counting();
    await go(makeReq(), h);
    const markersBefore = env.markers.length;
    const r = await go(makeReq(), h);
    expect(Object.keys(r.headers).map((k) => k.toLowerCase())).toEqual(['idempotent-replayed']);
    expect(env.markers.length).toBe(markersBefore);
  });

  it('a platform actor cannot see or replay a tenant actor’s row with the same key, and vice versa', async () => {
    const { env, go } = mk();
    const h = counting((n) => ({ status: 201, body: { n } }));
    await go(makeReq({ claims: tenantClaims({ sub: PLATFORM_1 }) }), h);
    const p = await go(platformReq(), h);
    expect(p).toMatchObject({ replayed: false, body: { n: 2 } });
    expect(env.rows()).toHaveLength(2);
  });
});
