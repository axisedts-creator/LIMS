// C6-T13 — worker task `reporting.release_if_eligible` (02-TRD §4.6 rule 5, §9; 03-APP-FLOW V5, auto-release flow). ACs: AC-06.1, AC-06.5, AC-06.8, AC-06.9 (auto path),
// AC-08.3 / AC-08.6 (audiences), 07-SECURITY T13. The task re-evaluates the latest rendered version as the SYSTEM actor: eligibility only from
// BillingPort.getReleaseEligibility, release mode `auto`, no access-log row (user actors only), same transaction rules as R6 (release.handlers.test.ts).
// ASSUMED: tasks/release_if_eligible.ts exports `releaseIfEligible` (TaskHandler) or `createReleaseIfEligible()`; payload { tenant_id, report_id, report_version_id }
// (what the render task enqueues, key `release:<version_id>`, 10 attempts); a transient failure THROWS (queue retry), "not releasable now" RESOLVES.
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_TASK, DUE_500, ELIGIBLE, EVENT, FULL_NAME, LAB, NOW, ORDER, OVERRIDE_ID, PHONE, EMAIL, REG_NO, RELEASE_TASK, SYSTEM_ACTOR, TENANT_A, V,
  billingDown, idN, money, releaseSetup, released, releasedEventValid, rendered, settle, type RS, type ReleaseWorldOpts,
} from './release.helpers.js';

const PAYLOAD = { tenant_id: TENANT_A, report_id: LAB, report_version_id: V(1) };
async function load(): Promise<(p: any, c: any) => Promise<void>> {
  let mod: any;
  try { mod = await import('../tasks/release_if_eligible.js'); } catch (e) { throw Object.assign(new Error(`task module missing: ${(e as Error).message}`), { name: 'TaskLoadError' }); }
  const t = mod.releaseIfEligible ?? mod.createReleaseIfEligible?.();
  if (typeof t !== 'function') throw Object.assign(new Error('tasks/release_if_eligible.ts must export releaseIfEligible (or createReleaseIfEligible())'), { name: 'TaskLoadError' });
  return t;
}
function setup(o: ReleaseWorldOpts = {}) {
  const s = releaseSetup({ versions: [rendered(1)], ...o });
  const run = async (payload: any = PAYLOAD, ctx: any = s.jobCtx()) => (await load())(payload, ctx);
  return { ...s, run };
}
const untouched = (s: RS & { run: unknown }, n = 1) => {
  expect(s.version(n)['status']).toBe('rendered'); expect(s.version(n)['released_at'] ?? null).toBeNull(); expect(s.report()['released_version_no'] ?? null).toBeNull();
  expect(s.published).toHaveLength(0); expect(s.jobs(DISPATCH_TASK)).toHaveLength(0);
};

describe('manifest wiring', () => {
  const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
  it('reporting.release_if_eligible is registered with 10 attempts and is the real task, not the T09 stub: with an eligible port it releases', async () => {
    const m = await manifest(); expect(typeof m.tasks[RELEASE_TASK]).toBe('function'); expect(m.maxAttempts[RELEASE_TASK]).toBe(10);
    const s = setup(); await m.tasks[RELEASE_TASK](PAYLOAD, s.jobCtx()); expect(s.version(1)['status']).toBe('released');
  });
});

describe('AC-06.1 hold: not eligible -> stays rendered, held', () => {
  it('due_outstanding (NPR 500): version stays rendered, held_basis = due_outstanding, held_checked_at = now; no event, no dispatch, no release fields', async () => {
    const s = setup({ billing: DUE_500 }); await s.run();
    untouched(s); expect(s.version(1)['held_basis']).toBe('due_outstanding'); expect(new Date(s.version(1)['held_checked_at']).toISOString()).toBe(NOW);
  });
  it('no_invoice -> held_basis no_invoice', async () => {
    const s = setup({ billing: { eligible: false, basis: 'no_invoice', balanceDue: money(0) } }); await s.run(); untouched(s); expect(s.version(1)['held_basis']).toBe('no_invoice');
  });
  it('the hold changes only the held columns (+ version / updated_*): status, content, pdf, report row untouched', async () => {
    const s = setup({ billing: DUE_500 }); const keep = (r: any) => JSON.stringify([r.status, r.content_sha256, r.pdf_sha256, r.pdf_object_path, r.audiences, r.release_basis]);
    const before = keep(s.version(1)); const reportBefore = JSON.stringify(s.report()); await s.run();
    expect(keep(s.version(1))).toBe(before); expect(JSON.stringify(s.report())).toBe(reportBefore);
  });
  it('asks BillingPort once for this order as the system actor; never anything else of the port', async () => {
    const s = setup({ billing: DUE_500 }); await s.run();
    expect(s.billing.calls).toEqual([{ orderId: ORDER, actorType: 'system', tenantId: TENANT_A }]); expect(s.billing.other).toEqual([]);
  });
  it('held then paid: a later run releases it (basis paid_in_full) with exactly one event; a third run is a no-op', async () => {
    let paid = false; const s = setup({ billing: () => (paid ? ELIGIBLE : DUE_500) });
    await s.run(); untouched(s); paid = true; await s.run(); await s.run();
    expect(s.version(1)).toMatchObject({ status: 'released', release_basis: 'paid_in_full' }); expect(s.published).toHaveLength(1); expect(s.jobs(DISPATCH_TASK)).toHaveLength(1);
  });
});

describe('release: system actor, mode auto', () => {
  it('eligible -> released: release_mode auto, released_by the system actor, release_basis, released_at = now, audiences, version + 1', async () => {
    const s = setup(); await s.run(); const v = s.version(1);
    expect(v).toMatchObject({ status: 'released', release_mode: 'auto', release_basis: 'paid_in_full', version: 4 });
    expect([SYSTEM_ACTOR, null, undefined]).toContain(v['released_by']); expect(new Date(v['released_at']).toISOString()).toBe(NOW);
    expect(s.report()).toMatchObject({ released_version_no: 1, version: 6 });
  });
  it.each([['paid_in_full'], ['zero_balance'], ['credit_party'], ['policy_not_enforced']])('basis %s is released and published', async (basis) => {
    const s = setup({ billing: { eligible: true, basis, balanceDue: money(basis === 'credit_party' ? 50_000 : 0) } }); await s.run();
    expect(s.version(1)).toMatchObject({ status: 'released', release_basis: basis }); expect(s.published[0]!.input.payload.release_basis).toBe(basis);
  });
  it('AC-06.5: credit-party order with dues -> released with basis credit_party', async () => {
    const s = setup({ billing: { eligible: true, basis: 'credit_party', balanceDue: money(125_000) } }); await s.run(); expect(s.version(1)).toMatchObject({ status: 'released', release_basis: 'credit_party' });
  });
  it('override: release_override_id stored from the port answer (never from the payload)', async () => {
    const s = setup({ billing: { eligible: true, basis: 'override', overrideId: OVERRIDE_ID, balanceDue: money(50_000) } });
    await s.run({ ...PAYLOAD, release_override_id: idN(0xbad), release_basis: 'paid_in_full' });
    expect(s.version(1)).toMatchObject({ status: 'released', release_basis: 'override', release_override_id: OVERRIDE_ID });
  });
  it('exactly one reporting.report.released.v1 as the system actor, in the same transaction; valid against the contract', async () => {
    const s = setup(); await s.run(); expect(s.published).toHaveLength(1); const p = s.published[0]!;
    expect(p.type).toBe(EVENT); expect(p.input.aggregate).toEqual({ type: 'report', id: LAB, seq: s.report()['version'] }); expect(p.input.idempotencyKey).toBe(`${LAB}:released:1`);
    expect(p.ctxTxIsOurTx).toBe(true); expect(p.ctxActor).toMatchObject({ type: 'system' }); expect(releasedEventValid(p)).toBe(true);
  });
  it('enqueues reporting.dispatch_release_deliveries once for this version', async () => {
    const s = setup(); await s.run(); expect(s.jobs(DISPATCH_TASK)).toHaveLength(1); expect(s.jobs(DISPATCH_TASK)[0]!.payload).toMatchObject({ tenant_id: TENANT_A, report_version_id: V(1) });
  });
  it('no access-log row for a system actor (CR-C6-008: user actors only)', async () => {
    const s = setup(); await s.run(); expect(s.accessLog).toHaveLength(0);
  });
  it('AC-06.9 (auto path): v2 released while v1 is released -> v1 superseded in the same transaction; event supersedes_version_no 1, report_kind amended', async () => {
    const s = setup({ versions: [released(1), rendered(2, { report_kind: 'amended' })], reportOver: { released_version_no: 1 } });
    await s.run({ ...PAYLOAD, report_version_id: V(2) });
    expect(s.version(2)['status']).toBe('released'); expect(s.version(1)).toMatchObject({ status: 'superseded', superseded_by_version_no: 2 });
    expect(s.published).toHaveLength(1); expect(s.published[0]!.input.payload).toMatchObject({ version_no: 2, supersedes_version_no: 1, report_kind: 'amended' });
  });
  it('replay-safe: the same job run twice releases once (one event, one dispatch)', async () => {
    const s = setup(); await s.run(); await s.run(); expect(s.published).toHaveLength(1); expect(s.jobs(DISPATCH_TASK)).toHaveLength(1); expect(s.billing.calls.length).toBeLessThanOrEqual(2);
  });
  it('every statement names tenant_id; tenant B is never written (REQ-SEC-024)', async () => {
    const s = setup(); await s.run(); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
});

describe('AC-06.8 and other reasons to wait', () => {
  it('auto_release = manual: a rendered, eligible version waits for a user release (billing may stay unasked)', async () => {
    const s = setup({ autoRelease: 'manual' }); await s.run(); untouched(s);
  });
  it('already released / superseded / discarded / rendering / render_failed -> no-op (no event, no second release)', async () => {
    for (const st of ['released', 'superseded', 'discarded', 'rendering', 'render_failed']) {
      const extra = st === 'released' || st === 'superseded' ? { released_at: '2026-11-06T09:00:00.000Z', release_basis: 'paid_in_full', audiences: ['patient'] } : st === 'discarded' ? {} : { pdf_object_path: null, pdf_sha256: null, page_count: null };
      const s = setup({ versions: [rendered(1, { status: st, ...extra })] }); const before = JSON.stringify(s.version(1)); expect(await settle(s.run())).toBe('ok');
      expect(JSON.stringify(s.version(1)), st).toBe(before); expect(s.published, st).toHaveLength(0); expect(s.jobs(DISPATCH_TASK), st).toHaveLength(0);
    }
  });
  it('a newer version exists (not the latest) -> nothing released and the job resolves (no endless retry)', async () => {
    const s = setup({ versions: [rendered(1), rendered(2)] }); expect(await settle(s.run())).toBe('ok'); untouched(s); expect(s.version(2)['status']).toBe('rendered');
  });
  it('cancelled report -> nothing released, job resolves', async () => {
    const s = setup({ reportOver: { state: 'cancelled', cancelled_at: NOW } }); expect(await settle(s.run())).toBe('ok'); untouched(s);
  });
  it('unknown version / foreign tenant payload / non-uuid -> skipped without touching billing', async () => {
    for (const p of [{ ...PAYLOAD, report_version_id: idN(0xdead) }, { ...PAYLOAD, tenant_id: idN(0xbbbb) }, { ...PAYLOAD, report_version_id: "x'; DROP TABLE reporting.report_versions;--" }, { tenant_id: TENANT_A }]) {
      const s = setup(); expect(await settle(s.run(p as any))).toBe('ok'); untouched(s); expect(s.billing.calls).toHaveLength(0);
    }
  });
  it('another tenant\'s version with the same id is never released (explicit tenant predicate, RLS off)', async () => {
    const s = setup({ versions: [rendered(1, { tenant_id: idN(0xbbbb) })], rls: false }); await settle(s.run()); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
});

describe('fail closed (T13: release without payment)', () => {
  it('BillingPort outage -> the task throws (queue retry), nothing released, no event', async () => {
    const s = setup({ billing: billingDown() }); const r = await settle(s.run()); expect(r).not.toBe('ok'); untouched(s);
  });
  it.each([
    ['eligible with a non-eligible basis', { eligible: true, basis: 'due_outstanding', balanceDue: money(50_000) }],
    ['not eligible with an eligible basis', { eligible: false, basis: 'paid_in_full', balanceDue: money(0) }],
    ['override without an override id', { eligible: true, basis: 'override', balanceDue: money(50_000) }],
    ['unknown basis', { eligible: true, basis: 'goodwill', balanceDue: money(0) }],
  ])('contradictory port answer (%s) releases nothing', async (_n, reply) => {
    const s = setup({ billing: reply as any }); await settle(s.run()); untouched(s);
  });
  it('FrontdeskPort (consent) outage -> throws for retry, nothing released: the audience set is never guessed', async () => {
    const s = setup({ consent: { down: true } }); expect(await settle(s.run())).not.toBe('ok'); untouched(s);
  });
  it('a failing event publish aborts the release: the error propagates (the job transaction rolls back), no dispatch is left behind after rollback', async () => {
    const s = setup({ eventsFail: new Error('event_log down') });
    await s.tx.query('SAVEPOINT job_tx', []); const r = await settle(s.run()); await s.tx.query('ROLLBACK TO SAVEPOINT job_tx', []);
    expect(r).not.toBe('ok'); expect(s.version(1)['status']).toBe('rendered'); expect(s.jobs(DISPATCH_TASK)).toHaveLength(0);
  });
});

describe('audiences (AC-08.3, AC-08.6) — computed the same way as R6', () => {
  const aud = async (o: ReleaseWorldOpts) => { const s = setup(o); await s.run(); return [...(s.published[0]?.input.payload.audiences ?? [])].sort(); };
  it('AC-08.3: referrer + shareWithReferrer -> patient, referrer, centre', async () => expect(await aud({ consent: { shareWithReferrer: true } })).toEqual(['centre', 'patient', 'referrer']));
  it('AC-08.3: shareWithReferrer false -> referrer omitted', async () => expect(await aud({ consent: { shareWithReferrer: false } })).toEqual(['centre', 'patient']));
  it('partner_manifest order -> partner added', async () => expect(await aud({ reportOver: { order_source: 'partner_manifest' } })).toEqual(['centre', 'partner', 'patient']));
  it('AC-08.6: no consent at all -> still released, audiences contain patient', async () => {
    const s = setup({ consent: {} }); await s.run(); expect(s.version(1)['status']).toBe('released'); expect(s.published[0]!.input.payload.audiences).toContain('patient');
  });
});

describe('PHI and dues links', () => {
  it('no name / phone / e-mail / registration number in the event, jobs, access log or logs', async () => {
    const s = setup({ consent: { shareWithReferrer: true, sms: true, email: true } }); await s.run();
    for (const p of [FULL_NAME, PHONE, EMAIL, REG_NO]) expect(s.allText()).not.toContain(p);
  });
  it('unrevoked dues links of the report are revoked (dues_settled) in the release transaction; a held run revokes nothing', async () => {
    const link: any = { tenant_id: TENANT_A, centre_id: idN(0xc1), id: idN(0x71), report_id: LAB, purpose: 'dues', revoked_at: null, revoke_reason_code: null };
    const held = setup({ billing: DUE_500, links: [{ ...link }] }); await held.run(); expect(held.links()[0]!['revoked_at'] ?? null).toBeNull();
    const ok = setup({ links: [{ ...link }] }); await ok.run(); expect(ok.links()[0]).toMatchObject({ revoke_reason_code: 'dues_settled' }); expect(ok.links()[0]!['revoked_at']).toBeTruthy();
  });
});
