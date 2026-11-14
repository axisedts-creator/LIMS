// C13 T12 — worker side of tracking: consumers lab.specimen.status_changed.v1 + reporting.report.released.v1, tasks partners.reconcile_orders + partners.enrich_report.
// 06-IMPLEMENTATION-PLAN row T12 done_when: "each 03 example; duplicate; stale seq; unknown order; partner_id mismatch ignored + metric; reconcile fills rejection reason and
//   cancellations from views (ReportingPort fake)". ACs: US-07.1-5, US-07.7, US-08.1.
// Spec: 02-TRD §7.2 (consumer rows), §8.1 (enrich_report, reconcile_orders), §8.2 (cron */10), §9 metric lims_partners_events_consumed_total{event_type,outcome};
//       03-APP-FLOW §3 (T1-T7, domain/tracking-status.ts), §5.3, §5.4, §8 (mismatch row); 05-SCHEMA order_tracking / tracked_specimens / order_reports; 03-IC §3.7, §3.17, §4.7 (ReportingPort),
//       §6 (lab.v_pub_specimen_timeline, frontdesk.v_pub_order_status); 07-SECURITY AB14 (partner_id mismatch).
// Handlers are reached ONLY through `manifest` of ../index.ts. Fake SQL subset + tables: api __tests__/tracking.world.ts (extends the T17 projection.world.ts).
// SEAMS (not fixed by the spec; the writer follows them or raises a dispute):
//   - The C0 wrapper (core/consumer.ts) already did the inbox insert + dedupe + schema validation, so the handlers do NOT touch partners.event_inbox (the fake rejects it).
//     "duplicate" at handler level = the same envelope delivered twice: the 2nd delivery must change nothing.
//   - Handler input = full envelope (event.tenant_id, event.aggregate.seq, event.payload). event.tenant_id !== ctx.tenantId -> throw (as the catalog.changed consumer), nothing written.
//   - Metrics via ctx.metrics.inc('lims_partners_events_consumed_total', { event_type, outcome }): applied | ignored_not_partner | stale | mismatch (TRD §9). A replay of an identical
//     event is 'stale' or 'duplicate' (either accepted).
//   - Writes use the system actor: created_by / updated_by = ctx.actor.id. receiving_centre_id of specimen / report rows is copied from the order_tracking row (never from an event).
//   - last_event_at = the event's changed_at (specimen) / released_at (report), never moved backwards. tracking_status = deriveTrackingStatus (domain/tracking-status.ts) over the line state,
//     the order's tracked_specimens and order_reports (T1-T7); 'cancelled' (line state or order_tracking.tracking_status) and 'reported' are never left by a late specimen event.
//   - rejected: rejection_reason_code stays NULL, job `SELECT app.enqueue_job('partners.reconcile_orders', {tenant_id, order_id}, 'reconcile:<order_id>')` in the same tx; stale/duplicate enqueue none.
//   - released: job partners.enrich_report payload {tenant_id, order_id, report_id, version_no}, job_key `enrich:<report_id>:<version_no>`. Redelivery never resets is_new / seen_* of a stored version.
//   - reconcile payloads: {tenant_id} = tick (all non-terminal orders of the tenant + converting-line sweep), {tenant_id, partner_id} = one partner's orders, {tenant_id, order_id} = one order.
//     Orders scanned: tracking_status NOT IN ('reported','cancelled') AND updated_at >= ctx.now() - 30 days (bound Date). A scanned order gets reconciled_at = ctx.now() and stored_order_status = view status.
//     Timeline row vs projection: specimen_version > last_seq -> update status, timestamps, last_seq = specimen_version, replaces/parent from the view; missing specimen -> insert; version <= last_seq
//     never moves status backwards but still fills a NULL rejection_reason_code / NULL timestamps. Converting lines: state converting AND updated_at < ctx.now() - 30 min -> conversion_failed,
//     failure_code 'common.internal', failed_at = ctx.now() (tick scope).
//   - enrich_report: ctx.ports.ReportingPort.getReleasedReports(ctx, { filter: { orderId, includeSuperseded: true } }) (exactly that filter), stores panel_names + enriched_at = ctx.now()
//     on the stored version(s); no matching released version -> throws (retry, TRD §8.1); port errors propagate; panel names are P3: never logged.
// NOT covered (spec silent, no CR): late v1 arriving after the v2 that supersedes it; report_count after supersede; reconcile batch loop beyond 500; line state written by the cancel path.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { AT, DAY, EX, L, O, P, R, S, SYSTEM, T_A, T_B, NOW_ISO, ago, id, iso, isoOrNull, jobsOf, literalLeaks, makeTrackingWorld, orderStatus, outcomes, portDown, PARTNER_RELEASED, projection,
  projectionWrites, RELEASED_EXAMPLE, releasedEvent, reportingPort, reportOf, row, run, seedTracking, specimenOf, statusEvent, STATUS_EXAMPLE, summary, timeline, trackingOf, type Row, type World,
} from '../../../../../api/src/modules/partners/__tests__/tracking.world.js';
import { manifest } from '../index.js';

const STATUS = 'lab.specimen.status_changed.v1', RELEASED = 'reporting.report.released.v1', RECONCILE = 'partners.reconcile_orders', ENRICH = 'partners.enrich_report';
const onStatus = manifest.subscriptions![STATUS]!, onReleased = manifest.subscriptions![RELEASED]!, reconcile = manifest.tasks![RECONCILE]!, enrich = manifest.tasks![ENRICH]!;

const fresh = () => { const w = makeTrackingWorld(); seedTracking(w); return w; };
const deliver = (w: World, ev: Row, over: Parameters<typeof run>[2] = {}) => run(w, (ctx) => onStatus(ev, ctx), over);
const release = (w: World, ev: Row, over: Parameters<typeof run>[2] = {}) => run(w, (ctx) => onReleased(ev, ctx), over);
const reconcileJob = (w: World, payload: Row, over: Parameters<typeof run>[2] = {}) => run(w, (ctx) => reconcile({ tenant_id: T_A, ...payload }, ctx), over);
const enrichJob = (w: World, payload: Row, port: ReturnType<typeof reportingPort>) => run(w, (ctx) => enrich({ tenant_id: T_A, order_id: EX.order, report_id: EX.report, version_no: 1, ...payload }, ctx), { port });
const status = (w: World, order = O.ex) => trackingOf(w, order).tracking_status;
const spec = (w: World, id_: string) => { const r = specimenOf(w, id_); return r && { status: r.status, last_seq: r.last_seq, received_at: isoOrNull(r.received_at), in_transit_at: isoOrNull(r.in_transit_at), collected_at: isoOrNull(r.collected_at), rejected_at: isoOrNull(r.rejected_at), reason: r.rejection_reason_code, replaces: r.replaces_specimen_id }; };
const refused = (r: { ok: boolean; error?: Error }) => { expect(r.ok).toBe(false); expect(r.error?.message ?? '').not.toMatch(/not implemented/); };   // a real refusal, not the T01 stub
const ok = (r: { ok: boolean; error?: Error }) => { expect(r.error).toBeUndefined(); expect(r.ok).toBe(true); };
const markSeen = (w: World, report: string, v: number) => { const r = reportOf(w, report, v)!; r.is_new = false; r.seen_at = new Date('2026-11-06T00:00:00Z'); r.seen_by = id(77); };

describe('manifest wiring — T12 replaces the T01 fail-closed stubs', () => {
  it('the four T12 entries are real handlers (a call on an unknown order / empty tick does not throw "not implemented")', async () => {
    const w = fresh();
    for (const r of [await deliver(w, statusEvent({ order_id: O.foreign })), await release(w, releasedEvent({ order_id: O.foreign })), await reconcileJob(w, {})]) expect(r.error?.message ?? '').not.toMatch(/not implemented/);
  });
});

describe('lab.specimen.status_changed.v1 — US-07.1 (03-IC §3.7 example, verbatim)', () => {
  it('received event for the example order: specimen row projected, order becomes in_lab, last_event_at = changed_at, system actor, metric applied', async () => {
    const w = fresh();
    const r = await deliver(w, statusEvent({}, 4));
    ok(r);
    expect(spec(w, EX.specimen)).toEqual({ status: 'received', last_seq: 4, received_at: AT.changed, in_transit_at: null, collected_at: null, rejected_at: null, reason: null, replaces: null });
    const s = specimenOf(w, EX.specimen)!;
    expect(s).toMatchObject({ tenant_id: T_A, order_id: EX.order, partner_id: P.x, receiving_centre_id: EX.centre, specimen_type_code: 'EDTA_WB', created_by: SYSTEM, updated_by: SYSTEM });
    expect(iso(s.changed_at)).toBe(AT.changed);
    const t = trackingOf(w, O.ex);
    expect(t.tracking_status).toBe('in_lab');
    expect(iso(t.last_event_at)).toBe(AT.changed);
    expect(outcomes(r.metrics, STATUS)).toEqual(['applied']);
    expect(w.t['partners.event_inbox']).toBeUndefined();                     // the wrapper owns the inbox
  });

  it('collected -> in_transit -> received: registered, in_transit (T6), in_lab (T5); each status fills its own timestamp column only', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ from_status: 'ordered', to_status: 'collected', changed_at: '2026-11-05T02:30:00.000Z' }, 2)));
    expect(status(w)).toBe('in_transit');
    ok(await deliver(w, statusEvent({ from_status: 'collected', to_status: 'in_transit', changed_at: '2026-11-05T02:45:00.000Z' }, 3)));
    expect(status(w)).toBe('in_transit');
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'in_transit', collected_at: '2026-11-05T02:30:00.000Z', in_transit_at: '2026-11-05T02:45:00.000Z', received_at: null });
    ok(await deliver(w, statusEvent({}, 4)));
    expect(status(w)).toBe('in_lab');
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', collected_at: '2026-11-05T02:30:00.000Z', in_transit_at: '2026-11-05T02:45:00.000Z', received_at: AT.changed });
  });

  it('a status without a timestamp column (ordered / in_process) stores status, changed_at and last_seq and leaves every timestamp NULL', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ from_status: undefined, to_status: 'ordered' }, 1)));
    expect(spec(w, EX.specimen)).toEqual({ status: 'ordered', last_seq: 1, received_at: null, in_transit_at: null, collected_at: null, rejected_at: null, reason: null, replaces: null });
    expect(status(w)).toBe('registered');
    ok(await deliver(w, statusEvent({ to_status: 'in_process' }, 6)));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'in_process', last_seq: 6, received_at: null });
    expect(status(w)).toBe('in_lab');
  });

  it('unknown extra payload fields are ignored (02-CV §7.2) and optional parent / replaces are stored NULL', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ surprise_field: { nested: true } }, 4)));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', replaces: null });
    expect(specimenOf(w, EX.specimen)!.parent_specimen_id).toBeNull();
  });

  it('a second specimen of the same order is a second row; the order stays in_lab', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, statusEvent({ specimen_id: S.b, to_status: 'collected', from_status: 'ordered', specimen_type_code: 'SST' }, 1)));
    expect(w.t['partners.tracked_specimens']!.filter((r) => r.order_id === EX.order)).toHaveLength(2);
    expect(status(w)).toBe('in_lab');
  });

  it('the order is found by order_id only for the event tenant: partner Y\'s order is updated for Y, X\'s order is untouched', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ specimen_id: S.y, order_id: O.y, centre_id: id(60) }, 2)));
    expect(specimenOf(w, S.y)).toMatchObject({ order_id: O.y, partner_id: P.y, receiving_centre_id: id(60) });
    expect(trackingOf(w, O.y).tracking_status).toBe('in_lab');
    expect(trackingOf(w, O.ex).tracking_status).toBe('registered');
  });
});

describe('lab.specimen.status_changed.v1 — US-07.2 / US-07.3 / US-07.4 duplicate, stale seq, unknown order', () => {
  it('duplicate delivery (same envelope twice): the second changes nothing and writes nothing to the projections', async () => {
    const w = fresh();
    const ev = statusEvent({}, 4);
    ok(await deliver(w, ev));
    const after1 = projection(w);
    w.log.length = 0;
    const again = await deliver(w, ev);
    ok(again);
    expect(projection(w)).toEqual(after1);
    expect(projectionWrites(w)).toEqual([]);
    expect(['stale', 'duplicate']).toContain(outcomes(again.metrics, STATUS)[0]);
  });

  it('stale seq (3 after 4): ignored — status, timestamps, last_seq and tracking unchanged; metric stale; no job', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    const before = projection(w);
    const r = await deliver(w, statusEvent({ from_status: 'collected', to_status: 'in_transit', changed_at: '2026-11-05T02:45:00.000Z' }, 3));
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', last_seq: 4, in_transit_at: null });
    expect(outcomes(r.metrics, STATUS)).toEqual(['stale']);
  });

  it('equal seq with a different status is also ignored (seq must be strictly greater)', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, statusEvent({ to_status: 'in_process', changed_at: AT.later }, 4)));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', last_seq: 4 });
  });

  it('a stale rejected event neither flips the status nor enqueues a reconcile job', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 7)));
    ok(await deliver(w, statusEvent({ from_status: 'received', to_status: 'rejected', changed_at: AT.later }, 5)));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', last_seq: 7, rejected_at: null });
    expect(jobsOf(w, RECONCILE)).toEqual([]);
  });

  it('out-of-order arrival (seq 4 before seq 2): 2 is dropped and 4 stays', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, statusEvent({ to_status: 'collected', from_status: 'ordered', changed_at: '2026-11-05T02:30:00.000Z' }, 2)));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', last_seq: 4, collected_at: null });
  });

  it('unknown order (no partner manifest line references it): no write to any projection, no job, metric ignored_not_partner, no error', async () => {
    const w = fresh();
    const before = projection(w);
    const r = await deliver(w, statusEvent({ order_id: id(555), specimen_id: S.unseen }, 4));
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(projectionWrites(w)).toEqual([]);
    expect(w.jobs).toEqual([]);
    expect(outcomes(r.metrics, STATUS)).toEqual(['ignored_not_partner']);
  });

  it('an order that exists only in ANOTHER tenant is unknown for this tenant (lookup is bound to tenant_id)', async () => {
    const w = fresh();
    const before = projection(w);
    const r = await deliver(w, statusEvent({ order_id: O.foreign, specimen_id: S.unseen }, 4));
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(trackingOf(w, O.foreign, T_B).tracking_status).toBe('registered');
    expect(outcomes(r.metrics, STATUS)).toEqual(['ignored_not_partner']);
  });

  it('envelope tenant differs from the job tenant: rejected, nothing written (tenant isolation)', async () => {
    const w = fresh();
    const before = projection(w);
    const r = await deliver(w, statusEvent({}, 4, { tenant: T_B }));
    refused(r);
    expect(projection(w)).toEqual(before);
  });
});

describe('lab.specimen.status_changed.v1 — US-07.5 rejection, reason by reconcile, replacement', () => {
  const rejected = (seq = 5) => statusEvent({ from_status: 'received', to_status: 'rejected', changed_at: AT.later }, seq);

  it('rejected: row stored without reason, order becomes action_needed (T4), reconcile job enqueued once for this order (job_key reconcile:<order_id>)', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, rejected(5)));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'rejected', last_seq: 5, rejected_at: AT.later, reason: null });
    expect(status(w)).toBe('action_needed');
    const jobs = jobsOf(w, RECONCILE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: { tenant_id: T_A, order_id: O.ex }, jobKey: `reconcile:${O.ex}` });
  });

  it('replacement specimen (replaces_specimen_id) received -> in_lab again; a replacement only collected leaves action_needed', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, rejected(5)));
    ok(await deliver(w, statusEvent({ specimen_id: S.repl, replaces_specimen_id: EX.specimen, from_status: 'ordered', to_status: 'collected', changed_at: '2026-11-05T06:00:00.000Z' }, 1)));
    expect(specimenOf(w, S.repl)!.replaces_specimen_id).toBe(EX.specimen);
    expect(status(w)).toBe('action_needed');
    ok(await deliver(w, statusEvent({ specimen_id: S.repl, replaces_specimen_id: EX.specimen, from_status: 'collected', to_status: 'received', changed_at: '2026-11-05T07:00:00.000Z' }, 2)));
    expect(status(w)).toBe('in_lab');
  });

  it('rejection reason comes from the reconcile job (timeline view), not from the event; the order stays action_needed', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, rejected(5)));
    timeline(w, { specimen_id: EX.specimen, order_id: EX.order, status: 'rejected', received_at: new Date(AT.changed), rejected_at: new Date(AT.later), rejection_reason_code: 'haemolysed', specimen_version: 5 });
    ok(await reconcileJob(w, { order_id: O.ex }));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'rejected', last_seq: 5, reason: 'haemolysed' });
    expect(status(w)).toBe('action_needed');
  });

  it('a rejected event on an unknown order enqueues nothing', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ order_id: id(555), specimen_id: S.unseen, from_status: 'received', to_status: 'rejected' }, 5)));
    expect(w.jobs).toEqual([]);
  });
});

describe('lab.specimen.status_changed.v1 — terminal states and statement hygiene', () => {
  it('cancelled order stays cancelled on a late specimen event (terminal never reverts); the specimen row is still projected', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ order_id: O.cancelled, specimen_id: S.x2 }, 4)));
    expect(trackingOf(w, O.cancelled).tracking_status).toBe('cancelled');
    expect(specimenOf(w, S.x2)).toMatchObject({ status: 'received' });
  });

  it('a reported order stays reported when a specimen event arrives', async () => {
    const w = fresh();
    w.t['partners.order_reports']!.push({ tenant_id: T_A, report_id: R.a, version_no: 1, order_id: O.done, partner_id: P.x, receiving_centre_id: EX.centre, kind: 'final', status: 'valid', released_at: AT.released,
      is_new: false, seen_at: AT.released, created_by: SYSTEM, updated_by: SYSTEM });   // the stored 'reported' state is backed by a valid final version
    ok(await deliver(w, statusEvent({ order_id: O.done, specimen_id: S.x2 }, 4)));
    expect(trackingOf(w, O.done).tracking_status).toBe('reported');
  });

  it('every value is a bound parameter: a hostile specimen_type_code is stored verbatim and never appears in statement text; no secrets / PHI in logs', async () => {
    const w = fresh();
    const evil = "EDTA'); DROP TABLE partners.order_tracking;--";
    const r = await deliver(w, statusEvent({ specimen_type_code: evil }, 4));
    // a > 64-char / odd code may be refused by the table CHECK; either way it must be a clean outcome, never an injected statement
    expect(literalLeaks(w, [evil, 'DROP TABLE', EX.specimen, EX.order, P.x])).toEqual([]);
    if (r.ok) expect(specimenOf(w, EX.specimen)!.specimen_type_code).toBe(evil);
    expect(r.logs.join('\n')).not.toContain(EX.patient);
    expect(w.t['partners.order_tracking']).toHaveLength(8);
  });
});

describe('reporting.report.released.v1 — US-08.1 (03-IC §3.17 example, verbatim)', () => {
  it('the verbatim example (audiences patient+referrer, no partner_id) is not a partner report: nothing stored, no enrich job, not "applied"', async () => {
    const w = fresh();
    const before = projection(w);
    const ev = releasedEvent({}, 1); ev.payload = { ...RELEASED_EXAMPLE };   // the builder merges over the partner variant, so set the verbatim payload directly
    expect(ev.payload).not.toHaveProperty('partner_id');
    const r = await release(w, ev);
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(jobsOf(w, ENRICH)).toEqual([]);
    expect(outcomes(r.metrics, RELEASED)).not.toContain('applied');
  });

  it('partner variant (partner_id X, audiences ∋ partner): version stored valid + is_new, order becomes reported (T2), report_count 1, enrich job enqueued', async () => {
    const w = fresh();
    const r = await release(w, releasedEvent());
    ok(r);
    const rep = reportOf(w, EX.report, 1)!;
    expect(rep).toMatchObject({ tenant_id: T_A, order_id: EX.order, partner_id: P.x, receiving_centre_id: EX.centre, kind: 'final', status: 'valid', is_new: true, seen_at: null, panel_names: null, enriched_at: null,
      created_by: SYSTEM, updated_by: SYSTEM });
    expect(iso(rep.released_at)).toBe(AT.released);
    const t = trackingOf(w, O.ex);
    expect(t).toMatchObject({ tracking_status: 'reported', report_count: 1 });
    expect(iso(t.last_event_at)).toBe(AT.released);
    const jobs = jobsOf(w, ENRICH);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: { tenant_id: T_A, order_id: EX.order, report_id: EX.report, version_no: 1 }, jobKey: `enrich:${EX.report}:1` });
    expect(outcomes(r.metrics, RELEASED)).toEqual(['applied']);
  });

  it('kind partial / preliminary -> partially_reported (T3); final / amended / addendum / an unknown future kind (stored as received) -> reported (T2)', async () => {
    for (const [kind, expected] of [['partial', 'partially_reported'], ['preliminary', 'partially_reported'], ['amended', 'reported'], ['addendum', 'reported'], ['corrected_v9', 'reported']] as const) {
      const w = fresh();
      ok(await release(w, releasedEvent({ report_kind: kind })));
      expect(reportOf(w, EX.report, 1)!.kind).toBe(kind);
      expect(status(w)).toBe(expected);
    }
  });

  it('version 2 with supersedes_version_no 1: v1 becomes superseded, v2 valid; both rows kept; order reported', async () => {
    const w = fresh();
    ok(await release(w, releasedEvent()));
    ok(await release(w, releasedEvent({ version_no: 2, report_kind: 'amended', supersedes_version_no: 1, released_at: AT.later }, 2)));
    expect(reportOf(w, EX.report, 1)!.status).toBe('superseded');
    expect(reportOf(w, EX.report, 2)).toMatchObject({ status: 'valid', kind: 'amended', is_new: true });
    expect(w.t['partners.order_reports']).toHaveLength(2);
    expect(status(w)).toBe('reported');
    expect(jobsOf(w, ENRICH).map((j) => j.jobKey).sort()).toEqual([`enrich:${EX.report}:1`, `enrich:${EX.report}:2`]);
  });

  it('a partial v1 superseded by a final v2 -> reported; a final v1 superseded by a partial v2 -> partially_reported (only valid versions count)', async () => {
    const a = fresh();
    ok(await release(a, releasedEvent({ report_kind: 'partial' })));
    ok(await release(a, releasedEvent({ version_no: 2, report_kind: 'final', supersedes_version_no: 1, released_at: AT.later }, 2)));
    expect(status(a)).toBe('reported');
    const b = fresh();
    ok(await release(b, releasedEvent({ report_kind: 'final' })));
    ok(await release(b, releasedEvent({ version_no: 2, report_kind: 'partial', supersedes_version_no: 1, released_at: AT.later }, 2)));
    expect(status(b)).toBe('partially_reported');
  });

  it('a released report of a rejected-specimen order wins over action_needed (T2 before T4)', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ from_status: 'received', to_status: 'rejected' }, 5)));
    expect(status(w)).toBe('action_needed');
    ok(await release(w, releasedEvent()));
    expect(status(w)).toBe('reported');
  });

  it('unknown extra payload fields are ignored', async () => {
    const w = fresh();
    ok(await release(w, releasedEvent({ future_field: 1 })));
    expect(reportOf(w, EX.report, 1)).toBeDefined();
  });

  it('a cancelled order stays cancelled when a report arrives (T1 first)', async () => {
    const w = fresh();
    ok(await release(w, releasedEvent({ order_id: O.cancelled })));
    expect(trackingOf(w, O.cancelled).tracking_status).toBe('cancelled');
  });
});

describe('reporting.report.released.v1 — duplicate, mismatch (AB14), not-partner, unknown order', () => {
  it('duplicate delivery: one row, no second change, and a version the partner already opened is NOT re-marked new', async () => {
    const w = fresh();
    const ev = releasedEvent();
    ok(await release(w, ev));
    markSeen(w, EX.report, 1);
    const before = projection(w);
    w.log.length = 0;
    const r = await release(w, ev);
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(w.t['partners.order_reports']).toHaveLength(1);
    expect(reportOf(w, EX.report, 1)).toMatchObject({ is_new: false });
    expect(reportOf(w, EX.report, 1)!.seen_at).not.toBeNull();
  });

  it('partner_id mismatch (event says Y, order is mapped to X): ignored, nothing stored for X or Y, no enrich job, metric outcome=mismatch (AB14)', async () => {
    const w = fresh();
    const before = projection(w);
    const r = await release(w, releasedEvent({ partner_id: P.y }));
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(w.t['partners.order_reports']).toEqual([]);
    expect(jobsOf(w, ENRICH)).toEqual([]);
    expect(trackingOf(w, O.ex).tracking_status).toBe('registered');
    expect(outcomes(r.metrics, RELEASED)).toEqual(['mismatch']);
    expect(r.logs.join('\n')).not.toContain(EX.patient);        // P1 ids only in tracking tables, never in the mismatch log
  });

  it('partner_id of another TENANT\'s partner is a mismatch too', async () => {
    const w = fresh();
    const r = await release(w, releasedEvent({ partner_id: P.b }));
    ok(r);
    expect(w.t['partners.order_reports']).toEqual([]);
    expect(outcomes(r.metrics, RELEASED)).toEqual(['mismatch']);
  });

  it('partner_id present but audiences lack "partner": ignored, nothing stored', async () => {
    const w = fresh();
    const before = projection(w);
    const r = await release(w, releasedEvent({ audiences: ['patient', 'centre'] }));
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(outcomes(r.metrics, RELEASED)).not.toContain('applied');
  });

  it('audiences contain "partner" but partner_id is absent: ignored, nothing stored', async () => {
    const w = fresh();
    const ev = releasedEvent(); delete (ev.payload as Row)['partner_id'];
    const before = projection(w);
    const r = await release(w, ev);
    ok(r);
    expect(projection(w)).toEqual(before);
    expect(outcomes(r.metrics, RELEASED)).not.toContain('applied');
  });

  it('partner report for an order no partner line references (or one that exists only in another tenant): ignored, nothing stored, no job', async () => {
    for (const order of [id(555), O.foreign]) {
      const w = fresh();
      const before = projection(w);
      const r = await release(w, releasedEvent({ order_id: order }));
      ok(r);
      expect(projection(w)).toEqual(before);
      expect(w.jobs).toEqual([]);
      expect(outcomes(r.metrics, RELEASED)).not.toContain('applied');
    }
  });

  it('envelope tenant differs from the job tenant: rejected, nothing written', async () => {
    const w = fresh();
    const before = projection(w);
    const r = await release(w, releasedEvent({}, 1, { tenant: T_B }));
    refused(r);
    expect(projection(w)).toEqual(before);
  });

  it('values are bound parameters (no uuid or kind text inside statement text)', async () => {
    const w = fresh();
    const kind = "x'); DELETE FROM partners.order_reports;--".slice(0, 32);
    await release(w, releasedEvent({ report_kind: kind }));
    expect(literalLeaks(w, [kind, 'DELETE FROM partners.order_reports', EX.report, EX.order])).toEqual([]);
  });
});

describe('partners.enrich_report — US-08.1 panel names via ReportingPort (system actor)', () => {
  const seeded = async () => { const w = fresh(); ok(await release(w, releasedEvent())); return w; };

  it('calls getReleasedReports with exactly { filter: { orderId, includeSuperseded: true } } as the job (system) context, stores panel_names + enriched_at', async () => {
    const w = await seeded();
    const port = reportingPort([summary({ panelNames: ['Synthetic Lipid Package', 'Synthetic Renal Package'] })]);
    const r = await enrichJob(w, {}, port);
    ok(r);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.input.filter).toEqual({ orderId: EX.order, includeSuperseded: true });
    expect(port.calls[0]!.ctx.actor).toMatchObject({ type: 'system' });
    expect(port.calls[0]!.ctx.tenantId).toBe(T_A);
    const rep = reportOf(w, EX.report, 1)!;
    expect(rep.panel_names).toEqual(['Synthetic Lipid Package', 'Synthetic Renal Package']);
    expect(iso(rep.enriched_at)).toBe(NOW_ISO);
    expect(rep).toMatchObject({ status: 'valid', is_new: true });
  });

  it('is_new / seen_* of the stored version are not touched; a summary of a version C13 does not hold (another report of the order) is not inserted', async () => {
    const w = await seeded();
    markSeen(w, EX.report, 1);
    const port = reportingPort([summary({ panelNames: ['Synthetic Lipid Package'] }), summary({ reportId: R.b, versionNo: 1, panelNames: ['Synthetic Patient-Only Package'] })]);
    ok(await enrichJob(w, {}, port));
    expect(reportOf(w, EX.report, 1)).toMatchObject({ is_new: false, panel_names: ['Synthetic Lipid Package'] });
    expect(reportOf(w, EX.report, 1)!.seen_at).not.toBeNull();
    expect(w.t['partners.order_reports']).toHaveLength(1);
    expect(reportOf(w, R.b, 1)).toBeUndefined();
  });

  it('superseded + current versions: the job\'s version is enriched with its own summary (v2 gets v2 panels, never v1\'s)', async () => {
    const w = await seeded();
    ok(await release(w, releasedEvent({ version_no: 2, report_kind: 'amended', supersedes_version_no: 1, released_at: AT.later }, 2)));
    const port = reportingPort([summary({ versionNo: 1, status: 'superseded', panelNames: ['Old Panel'] }), summary({ versionNo: 2, kind: 'amended', panelNames: ['New Panel'] })]);
    ok(await enrichJob(w, { version_no: 2 }, port));
    expect(reportOf(w, EX.report, 2)!.panel_names).toEqual(['New Panel']);
  });

  it('no released version found yet (C6 commit race): throws so the job retries; nothing written', async () => {
    const w = await seeded();
    const before = projection(w);
    for (const items of [[], [summary({ versionNo: 9 })], [summary({ reportId: R.b })]]) {
      const r = await enrichJob(w, {}, reportingPort(items));
      refused(r);
      expect(projection(w)).toEqual(before);
    }
  });

  it('port failure (common.dependency_unavailable) propagates for retry; nothing written', async () => {
    const w = await seeded();
    const before = projection(w);
    const r = await enrichJob(w, {}, reportingPort([], portDown()));
    refused(r);
    expect((r.error as LimsError).code ?? r.error?.message).toMatch(/dependency_unavailable/);
    expect(projection(w)).toEqual(before);
  });

  it('idempotent: running twice leaves the same panel_names; panel names (P3) are never logged', async () => {
    const w = await seeded();
    const port = reportingPort([summary({ panelNames: ['Synthetic Secret Panel Name'] })]);
    const a = await enrichJob(w, {}, port); const b = await enrichJob(w, {}, port);
    ok(a); ok(b);
    expect(reportOf(w, EX.report, 1)!.panel_names).toEqual(['Synthetic Secret Panel Name']);
    expect(a.logs.concat(b.logs).join('\n')).not.toContain('Synthetic Secret Panel Name');
  });

  it('payload tenant differs from the job tenant: rejected before any port call', async () => {
    const w = await seeded();
    const port = reportingPort([summary()]);
    const r = await run(w, (ctx) => enrich({ tenant_id: T_B, order_id: EX.order, report_id: EX.report, version_no: 1 }, ctx), { port });
    refused(r);
    expect(port.calls).toEqual([]);
  });
});

describe('partners.reconcile_orders — US-07.5 / US-07.7 views fill what events missed', () => {
  it('cancellation from frontdesk.v_pub_order_status: order -> cancelled (terminal), cancelled_at + stored_order_status set; another order\'s view status registered is recorded, not cancelled', async () => {
    const w = fresh();
    orderStatus(w, { order_id: O.ex, status: 'cancelled' });
    orderStatus(w, { order_id: O.x2, status: 'registered' });
    ok(await reconcileJob(w, {}));
    const t = trackingOf(w, O.ex);
    expect(t).toMatchObject({ tracking_status: 'cancelled', stored_order_status: 'cancelled' });
    expect(t.cancelled_at).not.toBeNull();
    expect(iso(t.reconciled_at)).toBe(NOW_ISO);
    expect(trackingOf(w, O.x2)).toMatchObject({ tracking_status: 'registered', stored_order_status: 'registered', cancelled_at: null });
    expect(iso(trackingOf(w, O.x2).reconciled_at)).toBe(NOW_ISO);
  });

  it('a cancelled order with later specimen events stays cancelled after the next reconcile (never reverts)', async () => {
    const w = fresh();
    orderStatus(w, { order_id: O.ex, status: 'cancelled' });
    ok(await reconcileJob(w, {}));
    ok(await deliver(w, statusEvent({}, 4)));
    orderStatus(w, { order_id: O.ex, status: 'registered' });   // a (bogus) later view row must not revive it
    ok(await reconcileJob(w, {}));
    expect(status(w)).toBe('cancelled');
  });

  it('missed events: a timeline row ahead of the projection (specimen_version > last_seq) updates status, timestamps and last_seq; tracking follows', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({ from_status: 'ordered', to_status: 'collected', changed_at: '2026-11-05T02:30:00.000Z' }, 2)));
    timeline(w, { specimen_id: EX.specimen, order_id: EX.order, status: 'received', collected_at: new Date('2026-11-05T02:30:00.000Z'), in_transit_at: new Date('2026-11-05T02:45:00.000Z'),
      received_at: new Date(AT.changed), specimen_version: 4 });
    ok(await reconcileJob(w, {}));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', last_seq: 4, received_at: AT.changed, in_transit_at: '2026-11-05T02:45:00.000Z' });
    expect(status(w)).toBe('in_lab');
  });

  it('a specimen never seen by the consumer is inserted from the timeline (partner / centre / order from the tracking row)', async () => {
    const w = fresh();
    timeline(w, { specimen_id: S.unseen, order_id: EX.order, status: 'in_transit', in_transit_at: new Date('2026-11-05T02:45:00.000Z'), specimen_version: 3 });
    ok(await reconcileJob(w, {}));
    expect(specimenOf(w, S.unseen)).toMatchObject({ tenant_id: T_A, order_id: EX.order, partner_id: P.x, receiving_centre_id: EX.centre, status: 'in_transit', last_seq: 3, created_by: SYSTEM });
    expect(status(w)).toBe('in_transit');
  });

  it('a timeline row BEHIND the projection never moves the status backwards', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 6)));
    timeline(w, { specimen_id: EX.specimen, order_id: EX.order, status: 'collected', collected_at: new Date('2026-11-05T02:30:00.000Z'), specimen_version: 2 });
    ok(await reconcileJob(w, {}));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'received', last_seq: 6 });
    expect(status(w)).toBe('in_lab');
  });

  it('fills rejection_reason_code of a rejected specimen even when the version equals last_seq (the event carried no reason); a second run changes nothing', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, statusEvent({ from_status: 'received', to_status: 'rejected', changed_at: AT.later }, 5)));
    timeline(w, { specimen_id: EX.specimen, order_id: EX.order, status: 'rejected', received_at: new Date(AT.changed), rejected_at: new Date(AT.later), rejection_reason_code: 'clotted', specimen_version: 5 });
    ok(await reconcileJob(w, {}));
    expect(spec(w, EX.specimen)).toMatchObject({ status: 'rejected', last_seq: 5, reason: 'clotted' });
    const after = projection(w);
    ok(await reconcileJob(w, {}));
    expect(projection(w)).toEqual(after);
  });

  it('replaces_specimen_id comes from the view: a replacement first seen by reconcile links to the rejected one and clears action_needed once received (T4)', async () => {
    const w = fresh();
    ok(await deliver(w, statusEvent({}, 4)));
    ok(await deliver(w, statusEvent({ from_status: 'received', to_status: 'rejected', changed_at: AT.later }, 5)));
    expect(status(w)).toBe('action_needed');
    timeline(w, { specimen_id: EX.specimen, order_id: EX.order, status: 'rejected', rejected_at: new Date(AT.later), rejection_reason_code: 'haemolysed', specimen_version: 5 });
    timeline(w, { specimen_id: S.repl, order_id: EX.order, status: 'received', received_at: new Date('2026-11-05T07:00:00.000Z'), replaces_specimen_id: EX.specimen, specimen_version: 3 });
    ok(await reconcileJob(w, {}));
    expect(specimenOf(w, S.repl)).toMatchObject({ replaces_specimen_id: EX.specimen, status: 'received' });
    expect(status(w)).toBe('in_lab');
  });

  it('timeline rows of an order that is not a partner order (or of another tenant) are never inserted', async () => {
    const w = fresh();
    timeline(w, { specimen_id: S.unseen, order_id: id(555), status: 'received', specimen_version: 2 });
    timeline(w, { tenant_id: T_B, specimen_id: S.x2, order_id: O.b, status: 'received', specimen_version: 2 });
    ok(await reconcileJob(w, {}));
    expect(w.t['partners.tracked_specimens']).toEqual([]);
  });
});

describe('partners.reconcile_orders — scope, window, converting lines, safety', () => {
  const seedViews = (w: World) => {
    for (const o of [O.ex, O.x2, O.old, O.done]) orderStatus(w, { order_id: o, status: 'cancelled' });
    orderStatus(w, { order_id: O.y, partner_id: P.y, status: 'cancelled' });
    orderStatus(w, { tenant_id: T_B, order_id: O.b, partner_id: P.b, status: 'cancelled' });
  };

  it('tick: every non-terminal order of the tenant in the 30-day window; reported / cancelled orders, orders untouched for 31 days and other tenants are not scanned', async () => {
    const w = fresh(); seedViews(w);
    ok(await reconcileJob(w, {}));
    for (const o of [O.ex, O.x2, O.y]) expect(trackingOf(w, o).tracking_status).toBe('cancelled');
    expect(trackingOf(w, O.old)).toMatchObject({ tracking_status: 'registered', reconciled_at: null });
    expect(trackingOf(w, O.done)).toMatchObject({ tracking_status: 'reported', reconciled_at: null });
    expect(trackingOf(w, O.b, T_B)).toMatchObject({ tracking_status: 'registered', reconciled_at: null });
  });

  it('partner scope {partner_id: X}: only X\'s orders are reconciled (job_key reconcile:partner:<id>, SA7)', async () => {
    const w = fresh(); seedViews(w);
    ok(await reconcileJob(w, { partner_id: P.x }));
    expect(trackingOf(w, O.ex).tracking_status).toBe('cancelled');
    expect(trackingOf(w, O.x2).tracking_status).toBe('cancelled');
    expect(trackingOf(w, O.y).tracking_status).toBe('registered');
  });

  it('order scope {order_id}: exactly that order', async () => {
    const w = fresh(); seedViews(w);
    ok(await reconcileJob(w, { order_id: O.x2 }));
    expect(trackingOf(w, O.x2).tracking_status).toBe('cancelled');
    expect(trackingOf(w, O.ex).tracking_status).toBe('registered');
    expect(trackingOf(w, O.y).tracking_status).toBe('registered');
  });

  it('an order scope naming another tenant\'s order (or none) does nothing', async () => {
    const w = fresh(); seedViews(w);
    const r = await reconcileJob(w, { order_id: O.b });
    ok(r);
    expect(trackingOf(w, O.b, T_B)).toMatchObject({ tracking_status: 'registered', reconciled_at: null });
  });

  it('lines converting for more than 30 minutes become conversion_failed (common.internal) on the tick; a 5-minute-old line and tenant B\'s line are untouched', async () => {
    const w = fresh();
    ok(await reconcileJob(w, {}));
    expect(row(w, 'manifest_lines', { tenant_id: T_A, id: L.converting })).toMatchObject({ state: 'conversion_failed', failure_code: 'common.internal' });
    expect(iso(row(w, 'manifest_lines', { tenant_id: T_A, id: L.converting })!.failed_at)).toBe(NOW_ISO);
    expect(row(w, 'manifest_lines', { tenant_id: T_A, id: L.convertingFresh })).toMatchObject({ state: 'converting', failure_code: null });
    expect(row(w, 'manifest_lines', { tenant_id: T_B, id: L.b })).toMatchObject({ state: 'converting', failure_code: null });
  });

  it('idempotent: a second tick right after the first writes no further change to the projections', async () => {
    const w = fresh(); seedViews(w);
    timeline(w, { specimen_id: EX.specimen, order_id: O.y, status: 'received', specimen_version: 2 });
    ok(await reconcileJob(w, {}));
    const after = projection(w);
    ok(await reconcileJob(w, {}));
    expect(projection(w)).toEqual(after);
  });

  it('an empty tenant (nothing in the views) is a clean no-op that still touches no foreign rows', async () => {
    const w = fresh();
    ok(await reconcileJob(w, { partner_id: P.y }));
    expect(trackingOf(w, O.ex)).toMatchObject({ tracking_status: 'registered', reconciled_at: null });
  });

  it('payload tenant differs from the job tenant, or a non-uuid partner_id / order_id: rejected, nothing written', async () => {
    const w = fresh(); seedViews(w);
    const before = projection(w);
    for (const payload of [{ tenant_id: T_B }, { partner_id: "x'; DROP TABLE partners.order_tracking;--" }, { order_id: 'not-a-uuid' }]) {
      const r = await run(w, (ctx) => reconcile({ tenant_id: T_A, ...payload }, ctx));
      refused(r);
      expect(projection(w)).toEqual(before);
    }
    expect(literalLeaks(w, ['DROP TABLE'])).toEqual([]);
  });

  it('reads of the views carry tenant_id as a bound parameter (a foreign tenant\'s view rows are never applied) and nothing is interpolated', async () => {
    const w = fresh(); seedViews(w);
    ok(await reconcileJob(w, {}));
    expect(literalLeaks(w, [T_A, T_B, P.x, O.ex, EX.order])).toEqual([]);
    expect(trackingOf(w, O.b, T_B).tracking_status).toBe('registered');
  });

  it('one reconcile run is one transaction: a failing write rolls everything back (no partial reconcile)', async () => {
    const w = fresh(); seedViews(w);
    const before = projection(w);
    w.failNext(/^\s*UPDATE partners\.manifest_lines/i);
    const r = await reconcileJob(w, {});
    refused(r);
    expect(projection(w)).toEqual(before);
  });
});

void DAY; void ago; void iso; void STATUS_EXAMPLE; void PARTNER_RELEASED; void P;
