// T0D-OFFLINE-3 (LD-322; offline design section 11 outage drill; done_when 6): the offline simulation harness.
// register, bill, collect, accession offline -> reconnect -> everything lands once with the right final numbers; 500 queued operations;
// a duplicate patient conflict, a price changed conflict and a revoked permission rejection are shown on the records.
// The "server" is the stateful stand-in of offline3.fixtures.ts (gap free numbers in arrival order, op_id idempotency, lost answers).
// Fails now because core/offline/flows.ts and numbers.ts do not exist.
import { describe, expect, it } from 'vitest';
import { CENTRE, T_CBC, U, createEnv, newPatient, regInput, sentOps, type Env } from './offline3.fixtures';

const pad = (n: number) => String(n).padStart(6, '0');
async function drainAll(env: Env, max = 20) {
  for (let i = 0; i < max; i++) {
    await env.drain();
    if ((await env.outbox.count()) === 0) return;
    env.c.advance(600_000); // past the backoff of the engine
  }
}

describe('500 queued operations land once, in order, with the right final numbers', () => {
  it('registers 500 orders offline, reconnects, and the server applies each exactly once in creation order', async () => {
    const env = await createEnv(); // blocks: 200 lab codes, 100 patient ids; the rest of the codes fall back to provisional PENDING
    const made: Array<{ op_id: string; invoice_no: string; receipt_nos: string[] }> = [];
    for (let i = 0; i < 500; i++) {
      made.push(await env.flows.registerOrder(regInput({
        items: [{ orderable_id: T_CBC.id }], payments: [{ method_code: 'cash', amount_received_paisa: 60000 }],
        ...(i % 5 === 0 ? { patient: { new_patient: newPatient({ full_name: `Synthetic Patient ${i}` }) } } : {}),
      })));
    }
    expect(await env.outbox.count()).toBe(500);
    expect(env.sim.calls.filter((c) => c.path === '/v1/core/sync/batches')).toHaveLength(0); // nothing was sent while "offline"

    await env.drain();

    const sizes = env.sim.batches.map((b) => b.ids.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(500);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(Math.max(...env.sim.batches.map((b) => b.bytes))).toBeLessThanOrEqual(1_048_576);
    expect(env.sim.batches.flatMap((b) => b.ids)).toEqual(made.map((m) => m.op_id)); // creation order = arrival order
    expect(env.sim.sim.applied.size).toBe(500);
    expect(new Set(env.sim.sim.arrival).size).toBe(500);
    expect(await env.outbox.count()).toBe(0);
    expect(await env.outbox.needsAttention()).toEqual([]);
    expect(await env.outbox.conflicts()).toEqual([]);

    // block numbers: each used at most once, all inside the blocks the device reserved
    const ops = sentOps(env.sim);
    const labs = ops.flatMap((o) => o.reserved_numbers?.lab_codes ?? []) as number[];
    const pats = ops.map((o) => o.reserved_numbers?.patient_id).filter((x) => x !== undefined) as number[];
    expect(new Set(labs).size).toBe(labs.length); expect(labs.length).toBe(200);
    expect(Math.min(...labs)).toBe(1001); expect(Math.max(...labs)).toBe(1200);
    expect(new Set(pats).size).toBe(pats.length); expect(pats.length).toBe(100);
    expect(Math.min(...pats)).toBe(5001); expect(Math.max(...pats)).toBe(5100);

    // final numbers: gap free, in arrival order, every provisional number mapped
    const maps = new Map((await env.outbox.numberMappings() as Array<{ provisional_number: string; final_number: string }>).map((m) => [m.provisional_number, m.final_number]));
    expect(maps.size).toBe(1000);
    made.forEach((m, i) => {
      expect(maps.get(m.invoice_no), `invoice of order ${i}`).toBe(`INV-${pad(i + 1)}`);
      expect(maps.get(m.receipt_nos[0]!), `receipt of order ${i}`).toBe(`RC-${pad(i + 1)}`);
    });
    for (const i of [0, 1, 249, 498, 499]) {
      expect(await env.flows.display(made[i]!.invoice_no)).toBe(`INV-${pad(i + 1)}`);
      expect(await env.flows.display(made[i]!.receipt_nos[0]!)).toBe(`RC-${pad(i + 1)}`);
    }

    // a second reconnect sends nothing and changes nothing
    const calls = env.sim.batches.length;
    await env.drain();
    expect(env.sim.batches.length).toBe(calls);
    expect(env.sim.sim.applied.size).toBe(500);
  });

  it('answers lost on the way (applied by the server, never received) do not duplicate or lose anything: 120 orders, final numbers still gap free', async () => {
    const env = await createEnv();
    const made = [];
    for (let i = 0; i < 120; i++) made.push(await env.flows.registerOrder(regInput({ items: [{ orderable_id: T_CBC.id }], payments: [{ method_code: 'cash', amount_received_paisa: 60000 }] })));
    env.sim.sim.dropResponses = 2; // the first batch is applied and its answer is lost twice
    await drainAll(env);
    expect(await env.outbox.count()).toBe(0);
    expect(env.sim.sim.applied.size).toBe(120);
    expect(env.sim.sim.inv).toBe(120); // the server assigned each final number once
    expect(env.sim.sim.rc).toBe(120);
    expect(env.sim.sim.arrival).toEqual(made.map((m) => m.op_id));
    for (const i of [0, 59, 119]) expect(await env.flows.display(made[i]!.invoice_no)).toBe(`INV-${pad(i + 1)}`);
  });
});

describe('a day offline: register, bill, collect, accession, then reconnect', () => {
  it('all four kinds of operation are sent in creation order with their DEVICE times, applied once, and the records lose their Pending sync mark', async () => {
    const env = await createEnv();
    const order = await env.flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }));
    env.c.advance(60_000);
    const receipt = await env.flows.recordReceipt({ order_id: U(700), method_code: 'cash', amount_received_paisa: 25000 });
    env.c.advance(60_000);
    await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    env.c.advance(60_000);
    await env.flows.receiveSpecimen({ specimen_id: U(500), version: 3, processing_centre_id: CENTRE });
    for (const id of [order.order_local_id, U(700), U(500)]) expect(await env.flows.statusOf(id)).toMatchObject({ state: 'pending' });

    await env.drain();

    const ops = sentOps(env.sim);
    expect(ops.map((o) => o.op_type)).toEqual(['registration.create_order', 'billing.record_receipt', 'collection.mark_collected', 'accession.receive']);
    const wire = env.sim.batches[0]!.body.operations as Array<{ device_created_at: string }>;
    expect(wire.map((o) => o.device_created_at)).toEqual([0, 1, 2, 3].map((n) => new Date(env.c.now() - (3 - n) * 60_000).toISOString())); // device time kept for the audit trail
    expect(env.sim.sim.applied.size).toBe(4);
    for (const id of [order.order_local_id, U(700), U(500)]) expect(await env.flows.statusOf(id)).toBeNull();
    expect(await env.flows.display(order.invoice_no)).toBe('INV-000001');
    expect(await env.flows.display(order.receipt_nos[0])).toBe('RC-000001');
    expect(await env.flows.display(receipt.receipt_no)).toBe('RC-000002');
  });
});

describe('what the server decides is shown on the record, never hidden', () => {
  async function conflicted() {
    const env = await createEnv();
    env.sim.sim.rules.push(
      (op) => (op.payload?.patient?.new_patient?.full_name === 'Meena Thapa' ? { status: 'conflict', error_code: 'frontdesk.patient_duplicate_suspected', conflict_id: U(901) } : undefined), // duplicate patient
      (op) => (op.op_type === 'registration.create_order' && op.payload?.visit_type === 'ipd' ? { status: 'conflict', error_code: 'common.version_conflict', conflict_id: U(902) } : undefined), // price changed
      (op) => (op.op_type === 'billing.record_receipt' ? { status: 'rejected', error_code: 'auth.forbidden' } : undefined), // permission revoked meanwhile
    );
    const dup = await env.flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }));
    const price = await env.flows.registerOrder(regInput({ visit_type: 'ipd' }));
    const revoked = await env.flows.recordReceipt({ order_id: U(701), method_code: 'cash', amount_received_paisa: 10000 });
    const fine = await env.flows.registerOrder(regInput());
    await env.drain();
    return { env, dup, price, revoked, fine };
  }

  it('a duplicate patient is a conflict with its code and conflict id; the order stays visible and its numbers stay provisional', async () => {
    const { env, dup } = await conflicted();
    expect(await env.flows.statusOf(dup.order_local_id)).toEqual({ state: 'conflict', code: 'frontdesk.patient_duplicate_suspected', conflict_id: U(901) });
    expect(await env.flows.localOrder(dup.order_local_id)).toMatchObject({ invoice_no: dup.invoice_no });
    expect(await env.flows.display(dup.invoice_no)).toBe(dup.invoice_no);
    expect((await env.flows.searchPatients('meena')).length).toBe(1); // the local patient is not dropped until a person resolves it
  });

  it('a price change is a conflict', async () => {
    const { env, price } = await conflicted();
    expect(await env.flows.statusOf(price.order_local_id)).toEqual({ state: 'conflict', code: 'common.version_conflict', conflict_id: U(902) });
  });

  it('a revoked permission rejects the operation and the record says so', async () => {
    const { env, revoked } = await conflicted();
    expect(await env.flows.statusOf(revoked.op_id)).toEqual({ state: 'rejected', code: 'auth.forbidden' });
    expect(await env.flows.display(revoked.receipt_no)).toBe(revoked.receipt_no);
  });

  it('one bad operation never fails the batch: the good order of the same batch is final, and the Offline panel lists exactly the 2 conflicts and 1 rejection', async () => {
    const { env, fine } = await conflicted();
    expect(await env.flows.statusOf(fine.order_local_id)).toBeNull();
    expect(await env.flows.display(fine.invoice_no)).toBe('INV-000001');
    expect((await env.outbox.conflicts()).map((c: { conflict_id: string }) => c.conflict_id).sort()).toEqual([U(901), U(902)]);
    expect((await env.outbox.needsAttention()).map((a: { code: string }) => a.code)).toEqual(['auth.forbidden']);
    expect(await env.outbox.count()).toBe(0);
  });
});
