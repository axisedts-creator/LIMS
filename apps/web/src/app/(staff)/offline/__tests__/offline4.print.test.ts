// T0D-OFFLINE-4 (LD-322 decision 2; done_when 4): report print offline only when every required sign off is accepted by the server or was captured on this
// device; it records a print marker operation and carries the "issued offline, pending sync" marker; after sync the marker goes away; a rejected sign off
// shows a recall on the report (and, through the attention list, in the Offline panel).
// Fails now because core/offline/labflows.ts does not exist.
import { describe, expect, it } from 'vitest';
import { P_PATH, P_VERIFY, PATH, USER, USER2, createEnv, drainAll, ops, policy, report, row, rule, signoff } from './offline4.fixtures';

const one = { required_verifiers: 1, require_pathologist: false };
const P_PRINT = [...P_VERIFY, 'reporting.report.print'];

describe('print eligibility', () => {
  it('every result already signed off on the server (verified with its full chain, or approved): allowed, with the print marker op, and the device did not rely on its own sign offs', async () => {
    const a = row(1, { status: 'approved', signoff_count: 2 }); const b = row(2, { status: 'verified', signoff_count: 1, signoffs: [signoff(USER2)] });
    const rep = report(1, [a.id, b.id]);
    const env = await createEnv({ results: [a, b], reports: [rep], policies: [policy(one)] });
    const out = await env.lab(USER, P_PRINT).printReport({ report_version_id: rep.id, variant: 'letterhead', copies: 2 });
    expect(out).toMatchObject({ ok: true, issued_offline: true, relied_on_device: false });
    expect(await env.pendingOps()).toMatchObject([{ op_type: 'report.print_marker', entity_id: rep.id, payload: { variant: 'letterhead', copies: 2 } }]);
    expect((await env.pendingOps())[0]!.base_version).toBeUndefined();
    expect(await env.lab(USER, P_PRINT).reportStatus(rep.id)).toEqual({ state: 'pending' });
  });

  it('a sign off captured on THIS device completes the report: allowed, and relied_on_device says so', async () => {
    const r = row(3); const rep = report(3, [r.id]);
    const env = await createEnv({ results: [r], reports: [rep], policies: [policy(one)] });
    await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id });
    const out = await env.lab(USER, P_PRINT).printReport({ report_version_id: rep.id, variant: 'plain', copies: 1 });
    expect(out).toMatchObject({ ok: true, issued_offline: true, relied_on_device: true });
    expect((await env.pendingOps()).map((o) => o.op_type)).toEqual(['result.verify', 'report.print_marker']); // the marker follows the sign off it relies on
  });

  it('a result that is NOT fully signed off blocks the print with reporting.print_not_ready; nothing is queued, no marker', async () => {
    const done = row(4, { status: 'approved' }); const half = row(5, { signoff_count: 1, signoffs: [signoff(USER2)] }); const none = row(6);
    const env = await createEnv({ results: [done, half, none], reports: [report(4, [done.id, half.id]), report(5, [done.id, none.id])], policies: [policy({ required_verifiers: 2 })] });
    const lab = env.lab(USER, P_PRINT);
    for (const n of [4, 5]) {
      const out = await lab.printReport({ report_version_id: report(n, []).id, variant: 'plain', copies: 1 });
      expect(out).toMatchObject({ ok: false, code: 'reporting.print_not_ready' });
      expect(out.message).not.toMatch(/reporting\.print_not_ready/);
    }
    expect(await env.pendingOps()).toHaveLength(0);
    expect(await lab.reportStatus(report(4, []).id)).toEqual({ state: 'none' });
  });

  it('an unknown report, a report with no results, a bad variant or copies, no permission, a locked store', async () => {
    const r = row(7, { status: 'approved' }); const env = await createEnv({ results: [r], reports: [report(7, [r.id]), report(8, [])] });
    const lab = env.lab(USER, P_PRINT);
    await expect(lab.printReport({ report_version_id: report(99, []).id, variant: 'plain', copies: 1 })).rejects.toMatchObject({ code: 'common.not_found' });
    expect(await lab.printReport({ report_version_id: report(8, []).id, variant: 'plain', copies: 1 })).toMatchObject({ ok: false, code: 'reporting.print_not_ready' }); // nothing to rely on
    for (const bad of [{ variant: 'color', copies: 1 }, { variant: 'plain', copies: 0 }, { variant: 'plain', copies: 6 }, { variant: 'plain', copies: 1.5 }]) {
      await expect(lab.printReport({ report_version_id: report(7, []).id, ...bad })).rejects.toMatchObject({ code: 'common.validation_failed' });
    }
    await expect(env.lab(USER, ['sync.use']).printReport({ report_version_id: report(7, []).id, variant: 'plain', copies: 1 })).rejects.toMatchObject({ code: 'auth.forbidden' });
    env.store.lock();
    await expect(lab.printReport({ report_version_id: report(7, []).id, variant: 'plain', copies: 1 })).rejects.toMatchObject({ code: 'offline.locked' });
  });

  it('the final sign off that needs MFA cannot make a report printable offline (it was refused, so there is nothing to rely on)', async () => {
    const r = row(9, { signoff_count: 1, signoffs: [signoff(USER2)] }); const rep = report(9, [r.id]);
    const env = await createEnv({ results: [r], reports: [rep] });
    expect(await env.lab(PATH, P_PATH).verifyResult({ result_id: r.id })).toMatchObject({ ok: false, code: 'sync.offline_not_allowed' });
    expect(await env.lab(PATH, [...P_PATH, 'reporting.report.print']).printReport({ report_version_id: rep.id, variant: 'plain', copies: 1 })).toMatchObject({ ok: false, code: 'reporting.print_not_ready' });
  });
});

describe('after reconnect: the marker goes away, or a rejected sign off recalls the report (done_when 4, 6)', () => {
  it('everything accepted: the report status goes pending -> confirmed (no marker) once the print op and the sign off it relied on are settled', async () => {
    const r = row(10); const rep = report(10, [r.id]);
    const env = await createEnv({ results: [r], reports: [rep], policies: [policy(one)] });
    const lab = env.lab(USER, P_PRINT);
    await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id });
    await lab.printReport({ report_version_id: rep.id, variant: 'letterhead', copies: 1 });
    expect(await lab.reportStatus(rep.id)).toEqual({ state: 'pending' });
    await drainAll(env);
    expect(await env.outbox.count()).toBe(0);
    expect(await lab.reportStatus(rep.id)).toEqual({ state: 'confirmed' });
    expect(ops(env).map((o: { op_type: string }) => o.op_type)).toEqual(['result.verify', 'report.print_marker']);
  });

  it('a sign off rejected at sync (sync.verification_policy_failed): the report shows RECALL with the code and the result ids; the print op itself is accepted', async () => {
    const r = row(11); const rep = report(11, [r.id]);
    const env = await createEnv({ results: [r], reports: [rep], policies: [policy(one)] });
    rule(env, (op) => (op.op_type === 'result.verify' ? { error_code: 'sync.verification_policy_failed' } : undefined));
    const lab = env.lab(USER, P_PRINT);
    await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id });
    await lab.printReport({ report_version_id: rep.id, variant: 'letterhead', copies: 1 });
    await drainAll(env);
    expect(await lab.reportStatus(rep.id)).toEqual({ state: 'recall', code: 'sync.verification_policy_failed', result_ids: [r.id] });
    // the same rejection sits in the needs attention list the Offline panel shows, so the panel can show the recall too
    expect((await env.outbox.needsAttention()).map((a: { op_type: string; code: string; entity_id?: string }) => [a.op_type, a.code, a.entity_id])).toEqual([['result.verify', 'sync.verification_policy_failed', r.id]]);
    expect(await env.flows.statusOf(r.id)).toEqual({ state: 'rejected', code: 'sync.verification_policy_failed' });
  });

  it('a rejected sign off recalls only the reports that relied on it; a report of other results stays confirmed', async () => {
    const bad = row(12); const good = row(13); const repBad = report(12, [bad.id]); const repGood = report(13, [good.id]);
    const env = await createEnv({ results: [bad, good], reports: [repBad, repGood], policies: [policy(one)] });
    rule(env, (op) => (op.op_type === 'result.verify' && op.entity_id === bad.id ? { error_code: 'sync.verification_policy_failed' } : undefined));
    const lab = env.lab(USER, P_PRINT); const v = env.lab(USER2, P_VERIFY);
    await v.verifyResult({ result_id: bad.id }); await v.verifyResult({ result_id: good.id });
    await lab.printReport({ report_version_id: repBad.id, variant: 'plain', copies: 1 });
    await lab.printReport({ report_version_id: repGood.id, variant: 'plain', copies: 1 });
    await drainAll(env);
    expect(await lab.reportStatus(repBad.id)).toMatchObject({ state: 'recall' });
    expect(await lab.reportStatus(repGood.id)).toEqual({ state: 'confirmed' });
  });

  it('the status survives a reload: a new flows object over the same store answers the same (the recall is not held in memory)', async () => {
    const r = row(14); const rep = report(14, [r.id]);
    const env = await createEnv({ results: [r], reports: [rep], policies: [policy(one)] });
    rule(env, (op) => (op.op_type === 'result.verify' ? { error_code: 'sync.verification_policy_failed' } : undefined));
    await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id });
    await env.lab(USER, P_PRINT).printReport({ report_version_id: rep.id, variant: 'plain', copies: 1 });
    await drainAll(env);
    expect(await env.lab(USER, P_PRINT).reportStatus(rep.id)).toMatchObject({ state: 'recall', code: 'sync.verification_policy_failed' });
    expect(await env.lab(USER, P_PRINT).reportStatus(report(77, []).id)).toEqual({ state: 'none' });
  });
});
