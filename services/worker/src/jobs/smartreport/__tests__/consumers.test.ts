// C14 T14 — event consumers lab.result.approved.v1 / lab.result.amended.v1 (06-PLAN row T14; 02-TRD §8.2; PRD AC-15.1, AC-15.2, AC-15.3, AC-15.5; 07-SECURITY tenant/system-actor rules).
// Driven through the REAL C0 wrapper (inbox dedupe, envelope validation, one tx) on the core fake DB. Seams: see t14.fakes.ts header.
// Fails now: both subscriptions are SR-T01 fail-closed stubs ("consumer <type> not implemented").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventValidators } from '../../../../../api/src/core/events/publish.js';
import { FIXED_NOW, setup, type Setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import {
  DEFAULT_DELAY, EV, ORDER, ORDER_2, R, SUMMARY, SYS, TA, TB, amendedEnvelope, approvedEnvelope, reset, runAtDelaySeconds, store, summaryRow, withPorts,
} from './t14.fakes.js';

vi.mock('../../../../../api/src/modules/smartreport/repository/summaries.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).summariesRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/reviews.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).reviewsRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/library.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).libraryRepo }));
vi.mock('../../../../../api/src/modules/smartreport/summary.service.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).summaryService }));

const APPROVED = 'lab.result.approved.v1', AMENDED = 'lab.result.amended.v1';
const JOB = 'smartreport.prebuild_summary';
const ENV = { approved: approvedEnvelope, amended: amendedEnvelope };

let s: Setup;
beforeEach(async () => { reset(); s = await setup([withPorts(manifest as any)]); });
afterEach(() => { vi.unstubAllEnvs(); });

/** Delivers `envelope` as the fanout would: event in core.event_log, then the evt.smartreport.<type> task. */
async function deliver(envelope: any): Promise<void> {
  s.world.seedEvent(envelope);
  await s.run(`evt.smartreport.${envelope.event_type}`, { tenant_id: envelope.tenant_id, event_id: envelope.event_id, event_type: envelope.event_type });
}
const settle = (p: Promise<unknown>) => p.then(() => undefined, (e) => e as Error);
const jobs = () => s.world.jobs.filter((j) => j.identifier === JOB);
const superseded = () => store.updates.filter((u) => u.patch['status'] === 'superseded');

describe('C14-T14 event contract', () => {
  it('the envelopes used here validate against contracts/events/lab.result.{approved,amended}.v1.schema.json (and unknown payload fields are dropped by the wrapper, not rejected)', async () => {
    const v = eventValidators();
    expect(v.get(APPROVED)!(approvedEnvelope())).toBe(true);
    expect(v.get(AMENDED)!(amendedEnvelope())).toBe(true);
    store.summaries.push(summaryRow());
    await deliver(approvedEnvelope({ extra: { future_field: 'x' } }));
    expect(superseded()).toHaveLength(1);                                    // handled, not dead-lettered
    expect(s.world.deadLetters).toHaveLength(0);
  });

  it('every consumer is registered per tenant as evt.smartreport.<type> with the consumer retry class (10 attempts, 02-CV §7.5)', () => {
    for (const t of [APPROVED, AMENDED]) expect(s.entry(`evt.smartreport.${t}`)).toMatchObject({ module: 'smartreport', kind: 'consumer', scope: 'per_tenant', maxAttempts: 10 });
  });
});

describe.each([['approved', APPROVED], ['amended', AMENDED]] as const)('%s consumer — common behaviour', (kind, type) => {
  const ev = (o: any = {}) => (ENV[kind] as any)(o);
  /** an event that supersedes a live summary of ORDER: approved = result not in the hashed set; amended = HGB 1 -> 2 */
  const changing = (o: any = {}) => (kind === 'approved' ? ev({ resultId: R.other, ...o }) : ev({ resultId: R.hgb, newVersion: 2, ...o }));
  const unchanged = (o: any = {}) => (kind === 'approved' ? ev({ resultId: R.hgb, ...o }) : ev({ resultId: R.hgb, newVersion: 2, ...o }));
  const liveUnchanged = () => (kind === 'approved' ? summaryRow() : summaryRow({ input_result_versions: [`${R.hgb}:2`, `${R.wbc}:1`] }));   // summary already holds the amended version

  it('AC-15.1/§8.2 step 3: a live summary that the event outdates becomes superseded (results_changed, no successor id) and one superseded review row is written, in the consumer tx', async () => {
    store.summaries.push(summaryRow());
    await deliver(changing());
    expect(superseded()).toHaveLength(1);
    const u = superseded()[0]!;
    expect(u).toMatchObject({ id: SUMMARY, expected: 3, tenantId: TA, actorId: SYS });
    expect(u.patch).toMatchObject({ status: 'superseded', superseded_reason: 'results_changed' });
    expect(typeof u.patch['superseded_at']).toBe('string');
    expect(u.patch).not.toHaveProperty('superseded_by_summary_id');         // stays NULL until a successor is built (D-107)
    expect(store.reviews).toHaveLength(1);
    expect(store.reviews[0]).toMatchObject({ summary_id: SUMMARY, centre_id: summaryRow().centre_id, action: 'superseded', tenant_id: TA, created_by: SYS });
    expect(store.reviews[0]!['actor_membership_id'] ?? null).toBeNull();     // system: no actor
    expect(store.reviews[0]!['comment'] ?? null).toBeNull();
  });

  it.each(['draft', 'rejected'])('a live %s summary is superseded too (live = draft | approved | rejected)', async (status) => {
    store.summaries.push(summaryRow({ status }));
    await deliver(changing());
    expect(superseded()).toHaveLength(1);
  });

  it('AC-15.3: an event that does not outdate the live summary changes nothing (no update, no review row)', async () => {
    store.summaries.push(liveUnchanged());
    await deliver(unchanged());
    expect(store.updates).toEqual([]);
    expect(store.reviews).toEqual([]);
    expect(store.summaries[0]).toMatchObject({ status: 'approved', version: 3 });
  });

  it('no live summary for the order -> nothing is superseded and the consumer does not fail', async () => {
    await deliver(changing());
    expect(store.updates).toEqual([]);
    expect(s.world.deadLetters).toHaveLength(0);
  });

  it('only the event order is touched: a live summary of another order, and a live summary of another tenant with the same order id, stay as they are', async () => {
    store.summaries.push(summaryRow({ id: 'other-order', order_id: ORDER_2 }), summaryRow({ id: 'other-tenant', tenant_id: TB }));
    await deliver(changing());
    expect(store.updates).toEqual([]);
    expect(store.liveReads).toEqual([{ tenantId: TA, orderId: ORDER }]);     // tenant from ctx.tenantId, order from the payload
  });

  it('a superseded summary is not live: a second, different event for the order does not supersede it again', async () => {
    store.summaries.push(summaryRow());
    await deliver(changing({ eventId: EV.one }));
    await deliver(changing({ eventId: EV.two }));
    expect(superseded()).toHaveLength(1);
    expect(store.reviews).toHaveLength(1);
  });

  it('AC-15.2: the same event delivered twice -> the second delivery is a no-op (inbox dedupe: one inbox row, handler body not entered again)', async () => {
    store.summaries.push(summaryRow());
    const e = changing();
    await deliver(e);
    const before = { calls: [...store.calls], jobs: jobs().length, reviews: store.reviews.length, updates: store.updates.length };
    await deliver(e);
    expect(s.world.inbox.filter((r) => r.module === 'smartreport' && r.event_id === e.event_id)).toHaveLength(1);
    expect(store.calls).toEqual(before.calls);                              // no lock, no live read, no update, no review, no build
    expect(store.reviews).toHaveLength(before.reviews);
    expect(store.updates).toHaveLength(before.updates);
    expect(jobs()).toHaveLength(before.jobs);
  });

  it('§8.2 step 2: ONE advisory lock for tenant + order is taken before the live summary is read', async () => {
    store.summaries.push(summaryRow());
    await deliver(changing());
    expect(store.lockQueries).toHaveLength(1);
    const q = store.lockQueries[0]!;
    expect(q.text + JSON.stringify(q.values)).toContain(ORDER);
    expect(q.text + JSON.stringify(q.values)).toContain(TA);
    expect(store.calls.indexOf('lock')).toBeLessThan(store.calls.indexOf('getLive'));
  });

  it('consumers call no external system and never build: no buildOrGet, no LabPort/FrontdeskPort/CatalogPort call', async () => {
    store.summaries.push(summaryRow());
    await deliver(changing());
    expect(store.buildCalls).toEqual([]);
    expect(store.portCalls.filter((c) => c.port !== 'identity')).toEqual([]);
  });

  it('dependency failure: a failing supersede update rejects the job (retried / dead-lettered, never silently acked) and the inbox row is rolled back with it', async () => {
    store.summaries.push(summaryRow());
    store.failUpdate = () => new Error('db down');
    const e = changing();
    s.world.seedEvent(e);
    const err = await settle(s.run(`evt.smartreport.${type}`, { tenant_id: TA, event_id: e.event_id, event_type: type }));
    expect(err?.message).toBe('db down');
    expect(s.world.inbox).toHaveLength(0);                                   // so the retry is processed, not deduped
    expect(jobs()).toHaveLength(0);
  });

  describe('AC-15.5: enqueue of smartreport.prebuild_summary is gated by flag + approved library + LIMS_SMARTREPORT_PREBUILD_ENABLED', () => {
    it('all on -> exactly one debounced job: payload {tenant_id, order_id}, job_key smartreport:prebuild:<order_id>, run_at = now + 120 s (default delay)', async () => {
      store.summaries.push(summaryRow());
      await deliver(changing());
      expect(jobs()).toHaveLength(1);
      expect(jobs()[0]).toMatchObject({ payload: { tenant_id: TA, order_id: ORDER }, jobKey: `smartreport:prebuild:${ORDER}` });
      const st = s.world.stmtsMatching(/app\.enqueue_job/).find((x) => x.values[0] === JOB)!;
      expect(runAtDelaySeconds(st, FIXED_NOW.getTime())).toBe(DEFAULT_DELAY);
    });

    it('enqueue is part of the consumer transaction and comes after the supersede (the draft the task builds replaces the superseded one)', async () => {
      store.summaries.push(summaryRow());
      await deliver(changing());
      expect(store.calls.indexOf('update')).toBeGreaterThanOrEqual(0);
      expect(store.calls.indexOf('enqueue')).toBeGreaterThan(store.calls.indexOf('update'));
      expect(store.calls.indexOf('enqueue')).toBeGreaterThan(store.calls.indexOf('review'));
      expect(jobs()[0]!.claims).toMatchObject({ tenant_id: TA, actor_type: 'system' });
    });

    it('LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS is honoured', async () => {
      vi.stubEnv('LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS', '300');
      await deliver(changing());
      expect(runAtDelaySeconds(s.world.stmtsMatching(/app\.enqueue_job/).find((x) => x.values[0] === JOB)!, FIXED_NOW.getTime())).toBe(300);
    });

    it('two different events for the same order within the window -> still one job (job_key debounce)', async () => {
      await deliver(changing({ eventId: EV.one }));
      await deliver(changing({ eventId: EV.two }));
      expect(jobs()).toHaveLength(1);
    });

    it('a different order gets its own job', async () => {
      await deliver(changing({ eventId: EV.one }));
      await deliver(changing({ eventId: EV.two, orderId: ORDER_2 }));
      expect(jobs().map((j) => j.jobKey).sort()).toEqual([`smartreport:prebuild:${ORDER}`, `smartreport:prebuild:${ORDER_2}`].sort());
    });

    it('feature flag smart_report off -> no job (the supersede still happens)', async () => {
      store.flag = false;
      store.summaries.push(summaryRow());
      await deliver(changing());
      expect(jobs()).toHaveLength(0);
      expect(superseded()).toHaveLength(1);
    });

    it('no approved library -> no job (the supersede still happens)', async () => {
      store.library = null;
      store.summaries.push(summaryRow());
      await deliver(changing());
      expect(jobs()).toHaveLength(0);
      expect(superseded()).toHaveLength(1);
    });

    it('library approved for another tenant only -> no job for this tenant', async () => {
      store.library = { id: 'lib-b', tenant_id: TB, status: 'approved' };
      await deliver(changing());
      expect(jobs()).toHaveLength(0);
    });

    it('LIMS_SMARTREPORT_PREBUILD_ENABLED=false -> no job (the supersede still happens)', async () => {
      vi.stubEnv('LIMS_SMARTREPORT_PREBUILD_ENABLED', 'false');
      store.summaries.push(summaryRow());
      await deliver(changing());
      expect(jobs()).toHaveLength(0);
      expect(superseded()).toHaveLength(1);
    });

    it('the flag is read for the event tenant (identity settings asked once per delivery, never cached across tenants)', async () => {
      await deliver(changing());
      expect(store.settingsCalls).toBeGreaterThanOrEqual(1);
    });

    it('flag lookup failure rejects the job (retry) instead of silently skipping the pre-build', async () => {
      store.settingsThrows = true;
      const e = changing();
      s.world.seedEvent(e);
      expect((await settle(s.run(`evt.smartreport.${type}`, { tenant_id: TA, event_id: e.event_id, event_type: type })))?.message).toBe('identity down');
      expect(s.world.inbox).toHaveLength(0);
    });
  });
});

describe('approved consumer — specifics (TRD §8.2 row 1)', () => {
  it('AC-15.3: a late event for an UNMAPPED result that is already in the hashed approved set never supersedes (input_result_versions = whole hashed set, not only mapped results)', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.hgb}:1`, `${R.txt}:1`] }));      // txt = unmapped free-text result, hashed but not scored
    await deliver(approvedEnvelope({ resultId: R.txt }));
    expect(store.updates).toEqual([]);
    expect(store.reviews).toEqual([]);
  });

  it('a result not in the set supersedes (the approved set grew)', async () => {
    store.summaries.push(summaryRow());
    await deliver(approvedEnvelope({ resultId: R.txt }));
    expect(superseded()).toHaveLength(1);
  });

  it('membership is by "<result_id>:<version_no>": the same result id at another version is not "already contained" (approved events carry version 1)', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.hgb}:2`] }));
    await deliver(approvedEnvelope({ resultId: R.hgb }));                                            // HGB:1 not in {HGB:2}
    expect(superseded()).toHaveLength(1);
  });
});

describe('amended consumer — specifics (TRD §8.2 row 2)', () => {
  it('AC-15.1: HGB amended to version 2 while the approved summary holds HGB:1 -> superseded (results_changed)', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.hgb}:1`] }));
    await deliver(amendedEnvelope({ resultId: R.hgb, newVersion: 2 }));
    expect(superseded()).toHaveLength(1);
    expect(superseded()[0]!.patch['superseded_reason']).toBe('results_changed');
  });

  it('stale amendment: the summary already has the new version (== new_version_no) -> no change', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.hgb}:2`] }));
    await deliver(amendedEnvelope({ resultId: R.hgb, newVersion: 2 }));
    expect(store.updates).toEqual([]);
    expect(store.reviews).toEqual([]);
  });

  it('stale amendment: the summary already has a LATER version (> new_version_no, events out of order) -> no change', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.hgb}:3`] }));
    await deliver(amendedEnvelope({ resultId: R.hgb, newVersion: 2 }));
    expect(store.updates).toEqual([]);
  });

  it('out-of-order pair: amendment to v3 then (late) amendment to v2 of the same result -> exactly one supersede', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.hgb}:1`] }));
    await deliver(amendedEnvelope({ eventId: EV.one, resultId: R.hgb, newVersion: 3 }));
    // the successor was built on HGB:3 meanwhile
    store.summaries.push(summaryRow({ id: 'succ', version: 1, status: 'draft', input_result_versions: [`${R.hgb}:3`] }));
    await deliver(amendedEnvelope({ eventId: EV.two, resultId: R.hgb, newVersion: 2 }));
    expect(superseded()).toHaveLength(1);
    expect(store.summaries.find((x) => x.id === 'succ')!.status).toBe('draft');
  });

  it('spec-literal: a result id the live summary does not contain at all is not "contained with a lower version" -> no supersede', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.wbc}:1`] }));
    await deliver(amendedEnvelope({ resultId: R.hgb, newVersion: 2 }));
    expect(store.updates).toEqual([]);
  });

  it('only the amended result decides: another result of the same summary having a lower version is irrelevant', async () => {
    store.summaries.push(summaryRow({ input_result_versions: [`${R.hgb}:2`, `${R.wbc}:1`] }));
    await deliver(amendedEnvelope({ resultId: R.hgb, newVersion: 2 }));
    expect(store.updates).toEqual([]);
  });
});

describe('security / isolation', () => {
  it('writes run as the smartreport system actor under the event tenant claims (no cross-tenant write through a forged payload order id)', async () => {
    store.summaries.push(summaryRow({ id: 'b-row', tenant_id: TB }));
    await deliver(approvedEnvelope({ resultId: R.other }));
    expect(store.updates).toEqual([]);                                       // tenant B's live summary of the same order id is out of reach
    expect(s.world.txLog.length).toBeGreaterThan(0);
    expect(s.world.txLog.every((t) => t.claims0.tenant_id === TA && t.claims0.sub === SYS && t.claims0.actor_type === 'system')).toBe(true);
  });

  it('the review row carries no PHI/free text: only ids and the action', async () => {
    store.summaries.push(summaryRow());
    await deliver(approvedEnvelope({ resultId: R.other }));
    expect(Object.keys(store.reviews[0]!).sort().filter((k) => !['id', 'centre_id', 'summary_id', 'action', 'reason_code', 'actor_membership_id', 'comment', 'tenant_id', 'created_by'].includes(k))).toEqual([]);
  });
});
