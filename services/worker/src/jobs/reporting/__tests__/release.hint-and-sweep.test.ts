// C6-T13 — `billing.balance.changed.v1` consumer (hint only) and cron `reporting.sweep_held_releases` (02-TRD §8.2 row billing.balance.changed.v1, §9;
// 03-IC §3.5; 01-PRD AC-06.2, AC-06.3). The event is only a HINT: the consumer stores the balance hint columns (ordered by balance_version) and enqueues
// `reporting.release_if_eligible` for a rendered version; it never calls BillingPort and never releases. The authoritative check is the task (release_if_eligible.test.ts).
// ASSUMED: consumers/billing.balance.changed.v1.ts exports `handle`; cron.ts exports `sweepHeldReleases` + `SWEEP_HELD`; the enqueued job reuses the render task's
// key `release:<report_version_id>` (so a duplicate collapses in the queue), 10 attempts, payload { tenant_id, report_id, report_version_id }.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { envelope } from './consumers.helpers.js';
import {
  DISPATCH_TASK, DUE_500, ELIGIBLE, FULL_NAME, LAB, NARR, ORDER, PHONE, EMAIL, REG_NO, RELEASE_TASK, SWEEP_HELD, TENANT_A, TENANT_B, V,
  idN, money, releaseSetup, rendered, released, settle, versionRow, type RS, type ReleaseWorldOpts, type Row,
} from './release.helpers.js';

const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
async function loadConsumer(): Promise<(e: any, c: any) => Promise<void>> {
  let mod: any; try { mod = await import('../consumers/billing.balance.changed.v1.js'); } catch (e) { throw Object.assign(new Error(`consumer missing: ${(e as Error).message}`), { name: 'TaskLoadError' }); }
  if (typeof mod.handle !== 'function') throw Object.assign(new Error('consumers/billing.balance.changed.v1.ts must export handle'), { name: 'TaskLoadError' });
  return mod.handle;
}
async function loadRelease(): Promise<(p: any, c: any) => Promise<void>> {
  let mod: any; try { mod = await import('../tasks/release_if_eligible.js'); } catch (e) { throw Object.assign(new Error(`task missing: ${(e as Error).message}`), { name: 'TaskLoadError' }); }
  return mod.releaseIfEligible ?? mod.createReleaseIfEligible?.();
}
const m = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const hint = (seq = 4, payloadOver: Row = {}, over: Row = {}) => envelope('billing.balance.changed.v1', 'billing', 'order_balance', ORDER, seq, {
  order_id: ORDER, balance_version: seq, invoiced: m(225_000), paid: m(225_000), credited: m(0), balance_due: m(0), cause: 'payment_recorded', release_eligible: true, release_basis: 'paid_in_full', ...payloadOver }, over);

function setup(o: ReleaseWorldOpts = {}) {
  const s = releaseSetup({ versions: [rendered(1)], ...o });
  return { ...s, consume: async (e: any = hint(), ctx: any = s.jobCtx()) => (await loadConsumer())(e, ctx) };
}
const releaseJobs = (s: RS) => s.jobs(RELEASE_TASK);
const hintCols = (r: Row) => ({ due: r['billing_balance_due_paisa'] ?? null, eligible: r['billing_release_eligible'] ?? null, ver: r['billing_balance_version'] ?? null });

describe('manifest wiring', () => {
  it('subscribes to billing.balance.changed.v1; sweep_held_releases (5 attempts) registered; crontab every 15 minutes per_tenant; manifest validates', async () => {
    const mf = await manifest();
    expect(typeof mf.subscriptions['billing.balance.changed.v1']).toBe('function');
    expect(typeof mf.tasks[SWEEP_HELD]).toBe('function'); expect(mf.maxAttempts[SWEEP_HELD]).toBe(5);
    const c = (mf.crontab as any[]).filter((x) => x.identifier === SWEEP_HELD);
    expect(c).toHaveLength(1); expect(c[0]).toMatchObject({ schedule: '*/15 * * * *', tenantScope: 'per_tenant' }); expect(c[0].maxAttempts ?? 5).toBe(5);
    expect(() => validateManifests([mf])).not.toThrow();
  });
  it('earlier crons and consumers are still registered', async () => {
    const mf = await manifest();
    for (const id of ['reporting.sweep_assembly', 'reporting.sweep_stuck_renders']) expect((mf.crontab as any[]).some((x) => x.identifier === id)).toBe(true);
    for (const t of ['frontdesk.order.created.v1', 'lab.order.ready_for_report.v1', 'catalog.changed.v1']) expect(typeof mf.subscriptions[t]).toBe('function');
  });
});

describe('billing.balance.changed.v1 -> hint columns + release job (AC-06.2)', () => {
  it('stores the hint on the reports of the order: billing_balance_due_paisa, billing_release_eligible, billing_balance_version (= aggregate.seq)', async () => {
    const s = setup(); await s.consume(hint(4, { balance_due: m(0), release_eligible: true }));
    for (const id of [LAB, NARR]) expect(hintCols(s.db.all('reporting.reports').find((r) => r['id'] === id)!)).toEqual({ due: 0, eligible: true, ver: 4 });
  });
  it('a not-yet-eligible hint is stored too (balance due 50 000 paisa) and enqueues nothing', async () => {
    const s = setup(); await s.consume(hint(5, { balance_due: m(50_000), release_eligible: false, release_basis: 'due_outstanding' }));
    expect(hintCols(s.report())).toEqual({ due: 50_000, eligible: false, ver: 5 }); expect(releaseJobs(s)).toHaveLength(0);
  });
  it('release_eligible = true + a rendered version -> enqueues reporting.release_if_eligible: key release:<version_id>, 10 attempts, tenant / report / version in the payload', async () => {
    const s = setup(); await s.consume();
    expect(releaseJobs(s)).toHaveLength(1); expect(releaseJobs(s)[0]).toMatchObject({ jobKey: `release:${V(1)}`, maxAttempts: 10 });
    expect(releaseJobs(s)[0]!.payload).toMatchObject({ tenant_id: TENANT_A, report_id: LAB, report_version_id: V(1) });
  });
  it('AC-06.3: it is only a hint — the consumer neither calls BillingPort nor releases anything', async () => {
    const s = setup(); await s.consume();
    expect(s.billing.calls).toHaveLength(0); expect(s.billing.other).toEqual([]);
    expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0); expect(s.jobs(DISPATCH_TASK)).toHaveLength(0);
  });
  it('both reports of the order are served: a rendered narrative version gets its own job', async () => {
    const nar = versionRow(1, { id: idN(0xd001), report_id: NARR, status: 'rendered', version: 2, rendered_at: '2026-11-07T11:55:00.000Z', created_at: '2026-11-07T11:50:00.000Z' });
    const s = setup({ versions: [rendered(1), nar] }); await s.consume();
    expect(releaseJobs(s).map((j) => j.payload.report_version_id).sort()).toEqual([V(1), idN(0xd001)].sort());
  });
  it.each(['rendering', 'render_failed', 'released', 'superseded', 'discarded'])('no rendered version (only %s) -> hint stored, no job', async (st) => {
    const extra = st === 'released' || st === 'superseded' ? { released_at: '2026-11-06T09:00:00.000Z', release_basis: 'paid_in_full', audiences: ['patient'] } : st === 'discarded' ? {} : { pdf_object_path: null, pdf_sha256: null, page_count: null };
    const s = setup({ versions: [rendered(1, { status: st, ...extra })] }); await s.consume();
    expect(releaseJobs(s)).toHaveLength(0); expect(hintCols(s.report()).ver).toBe(4);
  });
  it('an order without reports yet -> nothing happens (no throw, no job, no writes)', async () => {
    const s = setup(); expect(await settle(s.consume(hint(4, { order_id: idN(0x9999) })))).toBe('ok'); expect(releaseJobs(s)).toHaveLength(0); expect(s.db.writes().filter((w) => w.verb !== 'select')).toHaveLength(0);
  });
  it('stale / out-of-order: balance_version <= stored is ignored — hint columns unchanged, no job', async () => {
    const s = setup({ reportOver: { billing_balance_due_paisa: 50_000, billing_release_eligible: false, billing_balance_version: 5 } });
    await s.consume(hint(4)); await s.consume(hint(5));
    expect(hintCols(s.report())).toEqual({ due: 50_000, eligible: false, ver: 5 }); expect(releaseJobs(s)).toHaveLength(0);
  });
  it('a newer event after a stale one still applies (highest seq wins)', async () => {
    const s = setup({ reportOver: { billing_balance_version: 5, billing_balance_due_paisa: 50_000, billing_release_eligible: false } });
    await s.consume(hint(3)); await s.consume(hint(6)); expect(hintCols(s.report())).toEqual({ due: 0, eligible: true, ver: 6 }); expect(releaseJobs(s)).toHaveLength(1);
  });
  it('duplicate delivery of the same event: hint unchanged, any repeated enqueue carries the same job key (the queue collapses it)', async () => {
    const s = setup(); await s.consume(hint(4)); await s.consume(hint(4));
    expect(hintCols(s.report())).toEqual({ due: 0, eligible: true, ver: 4 }); expect(new Set(releaseJobs(s).map((j) => j.jobKey))).toEqual(new Set([`release:${V(1)}`]));
  });
  it('REQ-SEC-024: every statement names tenant_id; nothing of tenant B is touched (also with RLS off)', async () => {
    const s = setup({ rls: false, extraSeed: { 'reporting.reports': [
      ...[0].map(() => ({ tenant_id: TENANT_B, id: idN(0xb0b0), order_id: ORDER, family: 'laboratory', billing_balance_version: 1, centre_id: idN(0xc1), version: 1 })),
    ] as Row[] } });
    await s.consume(); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
    const other = s.db.all('reporting.reports').find((r) => r['id'] === idN(0xb0b0));
    if (other) expect(other['billing_balance_version']).toBe(1);
  });
  it('PHI: nothing but ids / paisa in jobs and logs', async () => {
    const s = setup(); await s.consume(); for (const p of [FULL_NAME, PHONE, EMAIL, REG_NO]) expect(s.allText()).not.toContain(p);
  });
});

describe('hint -> job -> task (the whole AC-06.2 / AC-06.3 path)', () => {
  const runEnqueued = async (s: ReturnType<typeof setup>) => { const rel = await loadRelease(); for (const j of [...releaseJobs(s)]) await rel(j.payload, s.jobCtx()); };
  it('AC-06.2: hint eligible -> the task asks BillingPort again -> paid_in_full -> released, ONE reporting.report.released.v1 with release_basis paid_in_full', async () => {
    const s = setup({ billing: ELIGIBLE }); await s.consume(); await runEnqueued(s);
    expect(s.billing.calls).toHaveLength(1); expect(s.version(1)).toMatchObject({ status: 'released', release_basis: 'paid_in_full' });
    expect(s.published).toHaveLength(1); expect(s.published[0]!.input.payload.release_basis).toBe('paid_in_full');
  });
  it('AC-06.2: a duplicate hint and a duplicate job still produce one event', async () => {
    const s = setup({ billing: ELIGIBLE }); await s.consume(); await s.consume(); await runEnqueued(s); expect(s.published).toHaveLength(1); expect(s.jobs(DISPATCH_TASK)).toHaveLength(1);
  });
  it('AC-06.3: the hint says eligible but the port says not eligible -> nothing is released, held_basis due_outstanding', async () => {
    const s = setup({ billing: DUE_500 }); await s.consume(); await runEnqueued(s);
    expect(s.billing.calls).toHaveLength(1); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0); expect(s.version(1)['held_basis']).toBe('due_outstanding');
  });
  it('AC-06.8: auto_release = manual -> the hint-triggered task still does not release', async () => {
    const s = setup({ billing: ELIGIBLE, autoRelease: 'manual' }); await s.consume(); await runEnqueued(s); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
});

describe('cron reporting.sweep_held_releases (hints are not authoritative)', () => {
  async function sweep(s: ReturnType<typeof setup>, payload: any = { tenant_id: TENANT_A }, ctx: any = s.jobCtx()) {
    let cron: any; try { cron = await import('../cron.js'); } catch (e) { throw Object.assign(new Error(String(e)), { name: 'TaskLoadError' }); }
    if (typeof cron.sweepHeldReleases !== 'function' || cron.SWEEP_HELD !== SWEEP_HELD) throw Object.assign(new Error('cron.ts must export sweepHeldReleases and SWEEP_HELD = reporting.sweep_held_releases'), { name: 'TaskLoadError' });
    await cron.sweepHeldReleases(payload, ctx);
  }
  const held = (n: number, over: Row = {}) => rendered(n, { held_basis: 'due_outstanding', held_checked_at: '2026-11-07T11:56:00.000Z', ...over });
  it('enqueues reporting.release_if_eligible (key release:<version_id>, 10 attempts) for a held rendered version in auto mode', async () => {
    const s = setup({ versions: [held(1)] }); await sweep(s);
    expect(releaseJobs(s)).toHaveLength(1); expect(releaseJobs(s)[0]).toMatchObject({ jobKey: `release:${V(1)}`, maxAttempts: 10 }); expect(releaseJobs(s)[0]!.payload).toMatchObject({ tenant_id: TENANT_A, report_id: LAB, report_version_id: V(1) });
  });
  it('held for no_invoice is swept as well', async () => {
    const s = setup({ versions: [held(1, { held_basis: 'no_invoice' })] }); await sweep(s); expect(releaseJobs(s)).toHaveLength(1);
  });
  it.each(['released', 'superseded', 'discarded', 'rendering', 'render_failed'])('a %s version is never swept', async (st) => {
    const extra = st === 'released' || st === 'superseded' ? { released_at: '2026-11-06T09:00:00.000Z', release_basis: 'paid_in_full', audiences: ['patient'] } : st === 'discarded' ? {} : { pdf_object_path: null, pdf_sha256: null, page_count: null };
    const s = setup({ versions: [held(1, { status: st, ...extra })] }); await sweep(s); expect(releaseJobs(s)).toHaveLength(0);
  });
  it('auto_release = manual -> nothing is swept', async () => {
    const s = setup({ versions: [held(1)], autoRelease: 'manual' }); await sweep(s); expect(releaseJobs(s)).toHaveLength(0);
  });
  it('it only enqueues: no BillingPort call, no release, no event, no write to the versions', async () => {
    const s = setup({ versions: [held(1)] }); const before = JSON.stringify(s.version(1)); await sweep(s);
    expect(s.billing.calls).toHaveLength(0); expect(JSON.stringify(s.version(1))).toBe(before); expect(s.published).toHaveLength(0);
  });
  it('payload tenant that is not the job tenant -> skipped (logged), nothing enqueued', async () => {
    const s = setup({ versions: [held(1)] }); await sweep(s, { tenant_id: idN(0xbbbb) }); expect(releaseJobs(s)).toHaveLength(0);
  });
  it('another tenant\'s held version is never enqueued (explicit tenant predicate, RLS off)', async () => {
    const s = setup({ versions: [held(1, { tenant_id: idN(0xbbbb) })], rls: false }); await sweep(s); expect(releaseJobs(s)).toHaveLength(0);
    expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('the sweep is not a second path around the task: released versions are untouched even when the port would say eligible', async () => {
    const s = setup({ versions: [held(1)], billing: ELIGIBLE }); await sweep(s); expect(s.version(1)['status']).toBe('rendered'); expect(s.published).toHaveLength(0);
  });
  it('more held versions than one tick takes (200): the batch rotates by held_checked_at, so the version skipped by tick 1 is enqueued by tick 2 (rule 5: every held version is re-checked)', async () => {
    const BATCH = 200, t = (i: number) => new Date(Date.parse('2026-11-07T10:00:00.000Z') + i * 1000).toISOString();
    const s = setup({ versions: Array.from({ length: BATCH + 1 }, (_v, i) => held(i + 1, { id: idN(0xd000 + i + 1), version_no: i + 1, held_checked_at: t(i) })) });
    const { wrapTx } = await import('./assemble.helpers.js');
    const ctx = s.jobCtx({ tx: wrapTx(s.tx, {} as any) });                 // applies ORDER BY / LIMIT like Postgres (the release tx wrapper ignores them)
    const keys = () => new Set(releaseJobs(s).map((j) => j.jobKey));
    const lastId = idN(0xd000 + BATCH + 1);
    await sweep(s, { tenant_id: TENANT_A }, ctx);
    expect(keys().size).toBe(BATCH); expect(keys().has(`release:${lastId}`)).toBe(false);        // newest-checked version waits for the next tick
    for (const j of releaseJobs(s)) await s.tx.query('UPDATE reporting.report_versions SET held_checked_at = $1 WHERE tenant_id = $2 AND id = $3', ['2026-11-08T00:00:00.000Z', TENANT_A, j.payload.report_version_id]);   // the task re-held them
    await sweep(s, { tenant_id: TENANT_A }, ctx);
    expect(keys().has(`release:${lastId}`)).toBe(true);
  });
  it('sweep -> task: a held version whose dues were paid (missed event) is released by the swept job', async () => {
    const s = setup({ versions: [held(1)], billing: ELIGIBLE }); await sweep(s); const rel = await loadRelease();
    for (const j of [...releaseJobs(s)]) await rel(j.payload, s.jobCtx());
    expect(s.version(1)).toMatchObject({ status: 'released', release_basis: 'paid_in_full' }); expect(s.published).toHaveLength(1);
  });
});

void money; void released;
