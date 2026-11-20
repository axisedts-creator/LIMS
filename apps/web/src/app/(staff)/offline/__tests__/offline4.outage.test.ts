// T0D-OFFLINE-4 (LD-322; offline design section 11 outage drill; done_when 6): ONE end to end test. A lab PC works a day without the server: register, bill,
// collect, accession (OFFLINE-3 flows), enter results, verify (policy checked locally, a pathologist approving offline under the tenant setting), print, close
// the cash day; reconnect (the first answer is lost); everything lands once and in order, numbers are finalised, the rejected sign off recalls its report, the
// locked result and the closed day are listed for a person, no duplicate, no lost operation, the audit trail carries device time and device id.
// Fails now because core/offline/labflows.ts and cashflows.ts do not exist.
import { describe, expect, it } from 'vitest';
import { PERMS, T_CBC, regInput } from './offline3.fixtures';
import { DEVICE, P_ENTER, P_PATH, P_VERIFY, PATH, USER, USER2, cashSession, createEnv, drainAll, policy, report, row, rule, U } from './offline4.fixtures';

describe('the outage drill of the design file, section 11, as one test', () => {
  it('a working day offline, then reconnect: each operation lands exactly once, numbers final, conflicts and recalls shown, nothing lost', async () => {
    const r1 = row(1); const r2 = row(2); const r3 = row(3);
    const repA = report(1, [r1.id]); const repB = report(2, [r2.id]); const day = cashSession(1);
    const env = await createEnv({ registration: true, results: [r1, r2, r3], reports: [repA, repB], sessions: [day], policies: [policy({ required_verifiers: 2, require_pathologist: true })] });
    const enterer = env.lab(USER, [...P_ENTER, ...PERMS]); const verifier = env.lab(USER2, P_VERIFY); const pathologist = env.lab(PATH, P_PATH, { offlineApproval: () => true });
    const printer = env.lab(USER, [...P_ENTER, 'reporting.report.print']);

    // the server will refuse these at sync (rules of the stand-in)
    rule(env, (op) => (op.op_type === 'result.enter' && op.payload.entries.some((e: { result_id: string }) => e.result_id === r3.id) ? { error_code: 'sync.result_locked' } : undefined));
    rule(env, (op) => (op.op_type === 'result.verify' && op.entity_id === r2.id ? { error_code: 'sync.verification_policy_failed' } : undefined));
    rule(env, (op) => (op.op_type === 'daily_cash.close' ? { status: 'conflict', conflict_id: U(7001), error_code: 'common.immutable_record' } : undefined));

    // 1 register and bill, collect, accession (OFFLINE-3)
    const reg = await env.flows.registerOrder(regInput({ items: [{ orderable_id: T_CBC.id }], payments: [{ method_code: 'cash', amount_received_paisa: 60000 }] }));
    const rc = await env.flows.recordReceipt({ order_id: reg.op_id, method_code: 'cash', amount_received_paisa: 1000 });
    await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    await env.flows.receiveSpecimen({ specimen_id: U(500), version: 3, processing_centre_id: U(3) });
    // 2 enter results (r3 on its own so its rejection does not take the others with it)
    expect(await enterer.enterResults({ entries: [{ result_id: r1.id, version: 3, value_numeric: '5.40' }, { result_id: r2.id, version: 3, value_numeric: '9.10' }] })).toMatchObject({ ok: true });
    expect(await enterer.enterResults({ entries: [{ result_id: r3.id, version: 3, value_text: 'Positive' }] })).toMatchObject({ ok: true });
    // 3 verify: the enterer is refused at once, a second person signs, the pathologist gives the final sign off offline (tenant setting on)
    expect(await enterer.verifyResult({ result_id: r1.id })).toMatchObject({ ok: false, code: 'lab.enterer_cannot_verify' });
    for (const r of [r1, r2]) expect(await verifier.verifyResult({ result_id: r.id })).toMatchObject({ ok: true, final: false });
    expect(await verifier.verifyResult({ result_id: r1.id })).toMatchObject({ ok: false, code: 'lab.verifier_not_distinct' });
    for (const r of [r1, r2]) expect(await pathologist.verifyResult({ result_id: r.id })).toMatchObject({ ok: true, final: true });
    // 4 print both reports offline
    for (const rep of [repA, repB]) expect(await printer.printReport({ report_version_id: rep.id, variant: 'letterhead', copies: 1 })).toMatchObject({ ok: true, issued_offline: true, relied_on_device: true });
    expect(await printer.reportStatus(repA.id)).toEqual({ state: 'pending' });
    // 5 close the cash day
    expect(await env.cash().closeDay({ session_id: day.id, counted: [{ method_code: 'cash', amount_paisa: 250000 }, { method_code: 'card', amount_paisa: 80000 }] })).toMatchObject({ ok: true, queued: true });

    const queued = await env.pendingOps();
    expect(queued.map((o) => o.op_type)).toEqual([
      'registration.create_order', 'billing.record_receipt', 'collection.mark_collected', 'accession.receive', 'result.enter', 'result.enter',
      'result.verify', 'result.verify', 'result.verify', 'result.verify', 'report.print_marker', 'report.print_marker', 'daily_cash.close',
    ]);
    expect(env.sim.calls.filter((c: { path: string }) => c.path === '/v1/core/sync/batches')).toHaveLength(0); // nothing was sent while "offline"

    // reconnect: the server applies the first batch but the answer never arrives; the device re-sends the same op ids
    env.sim.sim.dropResponses = 1;
    await drainAll(env);

    // every operation was sent in creation order, and re-sending changed nothing on the server
    const sent = env.sim.batches.flatMap((b: { ids: string[] }) => b.ids);
    expect(sent.slice(0, queued.length)).toEqual(queued.map((o) => o.op_id));
    const settledByServer = queued.filter((o) => !(o.op_type === 'daily_cash.close' || (o.op_type === 'result.verify' && o.entity_id === r2.id) || (o.op_type === 'result.enter' && o.payload.entries[0].result_id === r3.id)));
    expect(env.sim.sim.applied.size).toBe(settledByServer.length);
    expect([...env.sim.sim.applied.keys()].sort()).toEqual(settledByServer.map((o) => o.op_id).sort());
    expect(new Set(env.sim.sim.arrival).size).toBe(env.sim.sim.arrival.length);
    expect(await env.outbox.count()).toBe(0); // no lost operation: each is settled, rejected, or a conflict

    // the numbers are final, gap free, in arrival order; the screen shows the final ones from now on
    expect(await env.flows.display(reg.invoice_no)).toBe('INV-000001');
    expect(await env.flows.display(reg.receipt_nos[0])).toBe('RC-000001');
    expect(await env.flows.display(rc.receipt_no)).toBe('RC-000002');

    // what a person must look at: the locked entry, the two refused sign offs of r2, the closed day
    expect((await env.outbox.needsAttention()).map((a: { op_type: string; code: string }) => [a.op_type, a.code]).sort()).toEqual([
      ['result.enter', 'sync.result_locked'], ['result.verify', 'sync.verification_policy_failed'], ['result.verify', 'sync.verification_policy_failed'],
    ]);
    expect((await env.outbox.conflicts()).map((c: { op_type: string; conflict_id: string }) => [c.op_type, c.conflict_id])).toEqual([['daily_cash.close', U(7001)]]);
    expect(await env.flows.statusOf(r3.id)).toEqual({ state: 'rejected', code: 'sync.result_locked' });
    expect(await env.flows.statusOf(day.id)).toEqual({ state: 'conflict', code: 'common.immutable_record', conflict_id: U(7001) });

    // the printed reports: A was confirmed by the sign offs it relied on; B is recalled
    expect(await printer.reportStatus(repA.id)).toEqual({ state: 'confirmed' });
    expect(await printer.reportStatus(repB.id)).toMatchObject({ state: 'recall', code: 'sync.verification_policy_failed', result_ids: [r2.id] });

    // audit: the wire carries the device time and the device id of each operation (the server adds its own received time)
    for (const o of env.sim.batches.flatMap((b: { body: { operations: Array<Record<string, unknown>> } }) => b.body.operations)) {
      expect(Number.isNaN(Date.parse(String(o['device_created_at'])))).toBe(false);
    }
    for (const b of env.sim.batches) expect(b.body.device_id).toBe(DEVICE);
  });
});
