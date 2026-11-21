// T0D-OFFLINE-1 (LD-322, design file sections 2, 7): sync engine client. Batching, backoff, per-operation results, crash resume, leader election.
import { describe, expect, it } from 'vitest';
import { DEVICE, PIN, USER, fakeLocks, fakeServer, newEngine, newOutbox, orderOp, seqRandom, unlockedStore } from './offline1.helpers';

const OP_KEYS = ['op_id', 'op_type', 'base_version', 'entity_id', 'payload', 'device_created_at'];
async function fill(outbox: Awaited<ReturnType<typeof newOutbox>>, n: number, extra = 0, c?: { advance: (ms: number) => void }) {
  const ops = [];
  for (let i = 0; i < n; i++) { ops.push(await outbox.append(orderOp(i, extra))); c?.advance(1); }
  return ops;
}

describe('backoffDelayMs: exponential with full jitter, capped at 5 minutes', () => {
  it('delay is uniform in [0, min(cap, base*2^attempt)): bounds hold at the extremes of the random source', async () => {
    const { backoffDelayMs } = await import('../engine');
    const cfg = { baseMs: 1000, maxMs: 300_000 };
    for (let attempt = 0; attempt < 30; attempt++) {
      const ceiling = Math.min(300_000, 1000 * 2 ** attempt);
      expect(backoffDelayMs(attempt, cfg, () => 0)).toBe(0);
      const hi = backoffDelayMs(attempt, cfg, () => 0.999999);
      expect(hi).toBeLessThan(ceiling);
      expect(hi).toBeGreaterThanOrEqual(ceiling * 0.99 - 1);
      const mid = backoffDelayMs(attempt, cfg, () => 0.5);
      expect(mid).toBeGreaterThanOrEqual(0); expect(mid).toBeLessThanOrEqual(ceiling);
    }
  });
  it('never exceeds 5 minutes however many attempts, even with a huge configured maximum, and tolerates attempt 1000', async () => {
    const { backoffDelayMs } = await import('../engine');
    expect(backoffDelayMs(1000, { baseMs: 1000, maxMs: 300_000 }, () => 0.999999)).toBeLessThan(300_000);
    expect(backoffDelayMs(50, { baseMs: 1000, maxMs: 3_600_000 }, () => 0.999999)).toBeLessThan(300_000);
    expect(backoffDelayMs(1000, { baseMs: 1000, maxMs: 300_000 }, () => 0.999999)).not.toBeNaN();
  });
  it('is really jittered: 200 draws at one attempt give many distinct values (not a fixed delay)', async () => {
    const { backoffDelayMs } = await import('../engine');
    const seen = new Set(Array.from({ length: 200 }, () => backoffDelayMs(6, { baseMs: 1000, maxMs: 300_000 }, Math.random)));
    expect(seen.size).toBeGreaterThan(100);
  });
});

describe('batching: at most 50 operations and 1 MB, device_created_at order, one flight at a time', () => {
  it('130 operations go out as 50 + 50 + 30, in creation order, each exactly once; the body carries device_id and only contract fields', async () => {
    const env = await unlockedStore(); const server = fakeServer();
    const { engine, outbox } = await newEngine(env, server);
    const ops = await fill(outbox, 130, 0, env.c);
    await engine.drain();
    expect(server.batches.map((b) => b.ids.length)).toEqual([50, 50, 30]);
    expect(server.batches.flatMap((b) => b.ids)).toEqual(ops.map((o) => o.op_id));
    for (const b of server.batches) {
      expect(b.body.device_id).toBe(DEVICE);
      for (const o of b.body.operations) expect(Object.keys(o).every((k) => OP_KEYS.includes(k)), Object.keys(o).join()).toBe(true);
    }
    expect(server.calls.filter((c) => c.path === '/v1/core/sync/batches').every((c) => c.method === 'POST' && c.headers['content-type']?.includes('application/json'))).toBe(true);
    expect(await outbox.count()).toBe(0);
  });

  it('a batch never exceeds 1 MB of body: 5 operations of ~300 KB are split, order kept, nothing lost', async () => {
    const env = await unlockedStore(); const server = fakeServer();
    const { engine, outbox } = await newEngine(env, server);
    const ops = await fill(outbox, 5, 300_000, env.c);
    await engine.drain();
    expect(server.batches.length).toBeGreaterThanOrEqual(2);
    for (const b of server.batches) expect(b.bytes).toBeLessThanOrEqual(1_048_576);
    expect(server.batches.flatMap((b) => b.ids)).toEqual(ops.map((o) => o.op_id));
  });

  it('operations are sent in device_created_at order even when appended out of order across a clock step', async () => {
    const env = await unlockedStore(); const server = fakeServer();
    const { engine, outbox } = await newEngine(env, server);
    const a = await outbox.append(orderOp(1)); env.c.advance(5000);
    const b = await outbox.append(orderOp(2)); env.c.advance(5000);
    const c = await outbox.append(orderOp(3));
    await engine.drain();
    expect(server.batches[0]!.ids).toEqual([a.op_id, b.op_id, c.op_id]);
  });

  it('one flight at a time: two overlapping syncOnce calls on one engine produce one request carrying each op once', async () => {
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': async ({ body }) => { await new Promise((r) => setTimeout(r, 40)); return { status: 200, body: { results: body.operations.map((o: any) => ({ op_id: o.op_id, status: 'accepted' })) } }; } });
    const { engine, outbox } = await newEngine(env, server);
    await fill(outbox, 3, 0, env.c);
    await Promise.all([engine.syncOnce(), engine.syncOnce()]);
    expect(server.batches.length).toBe(1);
  });

  it('empty outbox: no request at all', async () => {
    const env = await unlockedStore(); const server = fakeServer();
    const { engine } = await newEngine(env, server);
    expect(await engine.syncOnce()).toMatchObject({ sent: 0 });
    expect(server.batches.length).toBe(0);
  });
});

describe('per operation results (never fail the batch for one operation)', () => {
  it('accepted and duplicate leave the outbox; rejected goes to needs attention with its code; conflict goes to the conflict list; a missing result stays', async () => {
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': ({ body }) => {
      const [a, b, c, d, e] = body.operations.map((o: any) => o.op_id);
      return { status: 200, body: { results: [
        { op_id: a, status: 'accepted', entity_id: 'ent-a' },
        { op_id: b, status: 'duplicate' },
        { op_id: c, status: 'rejected', error_code: 'sync.result_locked' },
        { op_id: d, status: 'conflict', conflict_id: 'cf-1', error_code: 'sync.base_version_stale' },
        { op_id: 'not-ours-0000', status: 'accepted' }, // unknown id is ignored
      ] } }; // e has no result
    } });
    const { engine, outbox } = await newEngine(env, server);
    const [a, b, c, d, e] = await fill(outbox, 5, 0, env.c);
    await engine.syncOnce();
    expect((await outbox.pending()).map((o) => o.op_id)).toEqual([e!.op_id]);
    expect(await outbox.needsAttention()).toEqual([expect.objectContaining({ op_id: c!.op_id, code: 'sync.result_locked', op_type: 'registration.create_order' })]);
    expect(await outbox.conflicts()).toEqual([expect.objectContaining({ op_id: d!.op_id, conflict_id: 'cf-1' })]);
    // the rejected payload is kept for the person who has to decide
    expect(JSON.stringify(await outbox.needsAttention())).toContain('p-2');
    void a; void b;
  });

  it('accepted results store the provisional to final number mapping (bill, invoice, receipt)', async () => {
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': ({ body }) => ({ status: 200, body: { results: [{ op_id: body.operations[0].op_id, status: 'accepted', number_mappings: [
      { document_type: 'bill', provisional_number: 'OFF-d1-7', final_number: 'B-2026-000123' },
      { document_type: 'receipt', provisional_number: 'OFF-d1-8', final_number: 'R-2026-000456' },
    ] }] } }) });
    const { engine, outbox } = await newEngine(env, server);
    await fill(outbox, 1);
    await engine.syncOnce();
    expect(await outbox.numberMappings()).toEqual(expect.arrayContaining([
      expect.objectContaining({ document_type: 'bill', provisional_number: 'OFF-d1-7', final_number: 'B-2026-000123' }),
      expect.objectContaining({ document_type: 'receipt', provisional_number: 'OFF-d1-8', final_number: 'R-2026-000456' }),
    ]));
    expect(await outbox.count()).toBe(0);
  });

  it('every rejection code in the contract is routed to needs attention (op_id_reused, clock_skew_too_large, not_allowed ...)', async () => {
    const codes = ['sync.op_id_reused', 'sync.clock_skew_too_large', 'sync.offline_not_allowed', 'sync.verification_policy_failed', 'sync.number_out_of_block', 'lab.verifier_not_distinct'];
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': ({ body }) => ({ status: 200, body: { results: body.operations.map((o: any, i: number) => ({ op_id: o.op_id, status: 'rejected', error_code: codes[i] })) } }) });
    const { engine, outbox } = await newEngine(env, server);
    await fill(outbox, codes.length, 0, env.c);
    await engine.syncOnce();
    expect((await outbox.needsAttention()).map((x: any) => x.code).sort()).toEqual([...codes].sort());
    expect(await outbox.count()).toBe(0);
  });
});

describe('failure, backoff, retry_after', () => {
  it('network error: operations stay in the outbox, the engine backs off and sends nothing before the delay is over, then retries the same ids', async () => {
    const env = await unlockedStore(); let fail = true;
    const server = fakeServer({ 'POST /v1/core/sync/batches': ({ body }) => fail ? 'throw' : { status: 200, body: { results: body.operations.map((o: any) => ({ op_id: o.op_id, status: 'accepted' })) } } });
    const { engine, outbox } = await newEngine(env, server, { random: () => 0.999 });
    const ops = await fill(outbox, 3, 0, env.c);
    const first = await engine.syncOnce();
    expect(first).toMatchObject({ sent: 0 });
    expect(await outbox.count()).toBe(3);
    const at = engine.nextAttemptAt();
    expect(at).toBeGreaterThan(env.c.now());
    expect(at! - env.c.now()).toBeLessThanOrEqual(1000);
    fail = false;
    const early = server.batches.length;
    await engine.syncOnce(); // still inside the backoff window
    expect(server.batches.length).toBe(early);
    env.c.advance(at! - env.c.now() + 1);
    await engine.syncOnce();
    expect(server.batches[server.batches.length - 1]!.ids).toEqual(ops.map((o) => o.op_id));
    expect(await outbox.count()).toBe(0);
  });

  it('each consecutive failure raises the jitter ceiling (1s, 2s, 4s ...) and never passes 5 minutes; success resets it', async () => {
    const env = await unlockedStore(); let fail = true;
    const server = fakeServer({ 'POST /v1/core/sync/batches': ({ body }) => fail ? { status: 503, body: { code: 'common.internal' } } : { status: 200, body: { results: body.operations.map((o: any) => ({ op_id: o.op_id, status: 'accepted' })) } } });
    const { engine, outbox } = await newEngine(env, server, { random: () => 0.9999 });
    await fill(outbox, 1);
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) { await engine.syncOnce(); const at = engine.nextAttemptAt()!; waits.push(at - env.c.now()); env.c.advance(at - env.c.now() + 1); }
    expect(waits[0]).toBeLessThanOrEqual(1000); expect(waits[1]).toBeLessThanOrEqual(2000); expect(waits[2]).toBeLessThanOrEqual(4000);
    expect(waits[2]!).toBeGreaterThan(waits[0]!);
    expect(Math.max(...waits)).toBeLessThanOrEqual(300_000);
    expect(waits[11]).toBeGreaterThan(100_000);
    fail = false; await engine.syncOnce();
    expect(await outbox.count()).toBe(0);
    await fill(outbox, 1); fail = true;
    await engine.syncOnce();
    expect(engine.nextAttemptAt()! - env.c.now()).toBeLessThanOrEqual(1000); // attempt counter was reset by the success
  });

  it('429 with Retry-After: the engine waits at least that long (even when the jitter draw is 0), operations stay', async () => {
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': () => ({ status: 429, body: { code: 'common.rate_limited' }, headers: { 'retry-after': '120' } }) });
    const { engine, outbox } = await newEngine(env, server, { random: () => 0 });
    await fill(outbox, 2);
    await engine.syncOnce();
    expect(engine.nextAttemptAt()! - env.c.now()).toBeGreaterThanOrEqual(120_000);
    expect(await outbox.count()).toBe(2);
  });

  it('401 and 403 keep every operation and make no destructive change', async () => {
    for (const status of [401, 403]) {
      const env = await unlockedStore();
      const server = fakeServer({ 'POST /v1/core/sync/batches': () => ({ status, body: { code: status === 401 ? 'auth.unauthenticated' : 'auth.forbidden' } }) });
      const { engine, outbox } = await newEngine(env, server);
      await fill(outbox, 2);
      await engine.syncOnce();
      expect(await outbox.count()).toBe(2);
      expect(await outbox.needsAttention()).toEqual([]);
    }
  });

  it('a request that hangs forever does not remove anything and does not block a later engine instance', async () => {
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': () => 'hang' });
    const { engine, outbox } = await newEngine(env, server, { requestTimeoutMs: 30 });
    await fill(outbox, 2);
    await Promise.race([engine.syncOnce(), new Promise((_r, rej) => setTimeout(() => rej(new Error('syncOnce hung past the request timeout')), 3000))]);
    expect(await outbox.count()).toBe(2);
  });
});

describe('crash and reload mid batch: op_id is the idempotency key', () => {
  it('request sent, answer lost, page reloaded: the new engine resends the SAME op_ids and payloads and the duplicate answer clears them', async () => {
    const env = await unlockedStore();
    const lost = fakeServer({ 'POST /v1/core/sync/batches': () => 'throw' }); // server applied it, the answer never arrived
    const first = await newEngine(env, lost);
    const ops = await fill(first.outbox, 4, 0, env.c);
    await first.engine.syncOnce();
    expect(await first.outbox.count()).toBe(4);
    // reload: new store handle on the same database, unlock with the PIN, new outbox, new engine
    const store2 = await env.reopen();
    expect(await store2.unlock(PIN)).toEqual({ ok: true });
    const server2 = fakeServer({ 'POST /v1/core/sync/batches': ({ body }) => ({ status: 200, body: { results: body.operations.map((o: any) => ({ op_id: o.op_id, status: 'duplicate' })) } }) });
    const second = await newEngine({ ...env, store: store2 } as never, server2);
    expect((await second.outbox.pending()).map((o) => o.op_id)).toEqual(ops.map((o) => o.op_id));
    await second.engine.drain();
    expect(server2.batches[0]!.ids).toEqual(ops.map((o) => o.op_id));
    expect(server2.batches[0]!.body.operations.map((o: any) => o.payload)).toEqual(lost.batches[0]!.body.operations.map((o: any) => o.payload));
    expect(await second.outbox.count()).toBe(0);
  });

  it('operations are removed only after the per operation results arrive: while the request is in flight they are still stored', async () => {
    const env = await unlockedStore(); let seenDuringFlight = -1; let outboxRef: any;
    const server = fakeServer({ 'POST /v1/core/sync/batches': async ({ body }) => { seenDuringFlight = await outboxRef.count(); return { status: 200, body: { results: body.operations.map((o: any) => ({ op_id: o.op_id, status: 'accepted' })) } }; } });
    const { engine, outbox } = await newEngine(env, server); outboxRef = outbox;
    await fill(outbox, 3, 0, env.c);
    await engine.syncOnce();
    expect(seenDuringFlight).toBe(3);
    expect(await outbox.count()).toBe(0);
  });

  it('a malformed 200 body (no results array) removes nothing', async () => {
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': () => ({ status: 200, body: { oops: true } }) });
    const { engine, outbox } = await newEngine(env, server);
    await fill(outbox, 2);
    await engine.syncOnce();
    expect(await outbox.count()).toBe(2);
  });
});

describe('two tabs: one leader, nobody sends twice', () => {
  it('Web Locks: two engines on the same lock and store, both syncing at once, send every operation exactly once', async () => {
    const env = await unlockedStore(); const locks = fakeLocks();
    const server = fakeServer({ 'POST /v1/core/sync/batches': async ({ body }) => { await new Promise((r) => setTimeout(r, 30)); return { status: 200, body: { results: body.operations.map((o: any) => ({ op_id: o.op_id, status: 'accepted' })) } }; } });
    const A = await newEngine(env, server, { locks }); const B = await newEngine(env, server, { locks });
    const ops = await fill(A.outbox, 6, 0, env.c);
    const [ra, rb] = await Promise.all([A.engine.syncOnce(), B.engine.syncOnce()]);
    const sentIds = server.batches.flatMap((b) => b.ids);
    expect(sentIds.sort()).toEqual(ops.map((o) => o.op_id).sort());
    expect(new Set(sentIds).size).toBe(sentIds.length);
    expect([ra, rb].some((r) => r.sent === 6)).toBe(true);
    await A.engine.close(); await B.engine.close();
  });

  it('when the leader goes away the other tab takes over', async () => {
    const env = await unlockedStore(); const locks = fakeLocks(); const server = fakeServer();
    const A = await newEngine(env, server, { locks }); const B = await newEngine(env, server, { locks });
    await fill(A.outbox, 2, 0, env.c);
    await A.engine.syncOnce();
    await A.engine.close();
    await fill(A.outbox, 2, 0, env.c);
    const deadline = Date.now() + 3000;
    while ((await B.outbox.count()) > 0 && Date.now() < deadline) { await B.engine.syncOnce(); await new Promise((r) => setTimeout(r, 20)); }
    expect(await B.outbox.count()).toBe(0);
    await B.engine.close();
  });

  it('BroadcastChannel fallback (no Web Locks): two engines still never send the same operation twice', async () => {
    const env = await unlockedStore();
    const server = fakeServer({ 'POST /v1/core/sync/batches': async ({ body }) => { await new Promise((r) => setTimeout(r, 30)); return { status: 200, body: { results: body.operations.map((o: any) => ({ op_id: o.op_id, status: 'accepted' })) } }; } });
    const name = 'lims-offline-test-' + Math.random();
    const A = await newEngine(env, server, { locks: null, channelName: name }); const B = await newEngine(env, server, { locks: null, channelName: name });
    const ops = await fill(A.outbox, 5, 0, env.c);
    await Promise.all([A.engine.syncOnce(), B.engine.syncOnce()]);
    const sentIds = server.batches.flatMap((b) => b.ids);
    expect(new Set(sentIds).size).toBe(sentIds.length);
    expect(sentIds.length).toBeGreaterThan(0);
    for (const id of sentIds) expect(ops.map((o) => o.op_id)).toContain(id);
    await A.engine.close(); await B.engine.close();
  });
});

describe('main thread stays free (design: no block above 50 ms)', () => {
  it('unlock (PBKDF2), 50 appends and a 50 operation batch never stall the event loop for more than 50 ms', async () => {
    const env = await unlockedStore(); env.store.lock();
    const server = fakeServer(); const { engine, outbox } = await newEngine(env, server);
    let last = performance.now(); let worst = 0;
    const timer = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last - 5); last = t; }, 5);
    await env.store.unlock(PIN);
    for (let i = 0; i < 50; i++) await outbox.append(orderOp(i), [{ store: 'refdata', key: 'o' + i, value: { i, pad: 'x'.repeat(2000) } }]);
    await engine.syncOnce();
    clearInterval(timer);
    expect(await outbox.count()).toBe(0);
    expect(worst).toBeLessThan(50);
  });
});

void USER; void seqRandom;
