// C9 T-19 — tat.service: sweep, refreshOrder, applyVerified, applyRelease, purgeExpired + endpoints #48-#50 (02-TRD §9, §5.7; PRD AC-14.1-14.8; 07-SECURITY S-02, S-03).
// Fake repo with the real semantics of TatRepo (tat.helpers.ts header = the seam); the pure clock (T-18) is trusted. Fails now: "Cannot find module ../service/tat.service.js".
import { describe, expect, it } from 'vitest';
import { createTatService } from '../service/tat.service.js';
import { MEM } from './setup.helpers.js';
import { CEN, DAY_MS, DETAIL_EXTRA, DTO_KEYS, FULL, MEMB, OIT, ORD, SPC, TAT, TENANT_A, TENANT_B, TST, T, code, forbidden, item, makeSettings, makeTatCtx, makeTatRepo, noRights, pend, readOnlyTat, rejection, totalItem,
  type FakeOpts, type TatSeed } from './tat.helpers.js';

const iso = (ms: number) => new Date(ms).toISOString();
const plus = (isoTs: string, ms: number) => iso(Date.parse(isoTs) + ms);
function setup(seed: TatSeed = {}, opts: FakeOpts = {}, settings: Parameters<typeof makeSettings>[0] = {}) {
  const fake = makeTatRepo(seed, opts); const st = makeSettings(settings);
  const service = createTatService({ repo: fake.repo, settings: st } as never) as any;
  return { fake, st, service, ctxAt: (hms: string, o: Parameters<typeof makeTatCtx>[0] = {}) => makeTatCtx({ now: T(hms), ...o }) };
}
const ZERO = { seen: 0, created: 0, stopped: 0, cancelled: 0, orphanClosed: 0 };

describe('sweep: first sight of a within_lab item (AC-14.1, vectors T1-T4)', () => {
  it.each([
    ['T1 11:11 (11,460 s, 79.6 %)', '11:11:00', 'none', []],
    ['T2 11:12 (11,520 s = 80 %, inclusive)', '11:12:00', 'warning', ['warning']],
    ['T3 12:00 (100 %): a sweep that finds it late raises every crossed level, ascending', '12:00:00', 'breached', ['warning', 'breached']],
    ['T4 14:00 (150 %)', '14:00:00', 'escalated', ['warning', 'breached', 'escalated']],
  ])('%s', async (_n, hms, level, events) => {
    const s = setup({ pending: [pend(1)] }); const c = s.ctxAt(hms);
    const res = await s.service.sweep(c.ctx);
    const row = s.fake.itemOf(1)!;
    expect(row).toMatchObject({ segment: 'within_lab', state: 'running', started_at: T('08:00:00'), start_basis: 'specimen_received_at', alert_level: level, target_seconds: 14_400, priority: 'routine', restart_count: 0,
      centre_id: CEN(1), order_id: ORD(1), order_item_id: OIT(1), test_id: TST(1), specimen_id: SPC(1), in_pending_view: true, last_seen_sweep_at: T(hms), version: 1 });
    expect(s.fake.eventsOf(row.id).map((e) => e.level)).toEqual(events);
    for (const e of s.fake.eventsOf(row.id)) expect(e).toMatchObject({ raised_at: T(hms), restart_no: 0, centre_id: CEN(1) });
    expect(res).toMatchObject({ seen: 1, created: 1 });
  });
  it('an event row records the elapsed seconds at raise time; priority, department and centre are copied from the pending row', async () => {
    const s = setup({ pending: [pend(1, { priority: 'urgent', department_id: null, centre_id: CEN(2), tat_target_seconds: 7200 })] }); await s.service.sweep(s.ctxAt('09:40:00').ctx);
    const row = s.fake.itemOf(1)!; expect(row).toMatchObject({ priority: 'urgent', department_id: null, centre_id: CEN(2), target_seconds: 7200, alert_level: 'warning' });
    expect(s.fake.eventsOf(row.id)[0]).toMatchObject({ level: 'warning', elapsed_seconds: 6000, centre_id: CEN(2) });
  });
  it('the result lists every raised alert with its segment and the lag (now - the instant the threshold was crossed)', async () => {
    const s = setup({ pending: [pend(1)] }); const res = await s.service.sweep(s.ctxAt('11:12:30').ctx);
    expect(res.raised).toEqual([{ level: 'warning', segment: 'within_lab', lagSeconds: 30 }]);
    const late = setup({ pending: [pend(1)] }); const r2 = await late.service.sweep(late.ctxAt('14:00:10').ctx);
    expect(r2.raised).toEqual([{ level: 'warning', segment: 'within_lab', lagSeconds: 10_090 }, { level: 'breached', segment: 'within_lab', lagSeconds: 7_210 }, { level: 'escalated', segment: 'within_lab', lagSeconds: 10 }]);
    expect(r2.openAlerts).toEqual({ warning: 0, breached: 0, escalated: 1 });
  });
  it('a custom tat_warn_pct / tat_escalate_pct of the tenant settings is honoured', async () => {
    const s = setup({ pending: [pend(1)] }, {}, { tatWarnPct: 50, tatEscalatePct: 200 }); await s.service.sweep(s.ctxAt('10:00:00').ctx);   // 2 h = 50 %
    expect(s.fake.itemOf(1)).toMatchObject({ alert_level: 'warning' });
  });
  it('a specimen not received yet creates a not_started clock with no start (TC1); the next sweep with received_at starts it (TC3)', async () => {
    const s = setup({ pending: [pend(1, { received_at: null, item_status: 'collected' })] }); await s.service.sweep(s.ctxAt('08:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'not_started', started_at: null, start_basis: 'specimen_received_at', alert_level: 'none' });
    s.fake.state.pending[0]!.received_at = T('08:30:00'); await s.service.sweep(s.ctxAt('09:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'running', started_at: T('08:30:00'), start_basis: 'specimen_received_at' });
  });
});

describe('sweep: incremental, idempotent, no version churn', () => {
  it('a level crossed since the last sweep inserts exactly one event; a repeated sweep at the same instant or later inserts none', async () => {
    const s = setup({ pending: [pend(1)] });
    await s.service.sweep(s.ctxAt('11:11:00').ctx); await s.service.sweep(s.ctxAt('11:12:00').ctx); await s.service.sweep(s.ctxAt('11:12:00').ctx); await s.service.sweep(s.ctxAt('11:40:00').ctx);
    expect(s.fake.eventsOf(s.fake.itemOf(1)!.id).map((e) => e.level)).toEqual(['warning']);
    expect(s.fake.itemOf(1)).toMatchObject({ alert_level: 'warning', alert_level_at: T('11:12:00') });
  });
  it('a sweep that changes nothing but the last-seen stamp leaves `version` alone (a minute tick must not invalidate a user\'s If-Match) and issues no updateItems', async () => {
    const s = setup({ pending: [pend(1)], items: [item(1, { version: 4, alert_level: 'warning', last_seen_sweep_at: T('11:12:00') })] });
    s.fake.calls.length = 0; await s.service.sweep(s.ctxAt('11:13:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ version: 4, last_seen_sweep_at: T('11:13:00') }); expect(s.fake.ops()).not.toContain('updateItems'); expect(s.fake.ops()).toContain('touchSeen');
  });
  it('a level change bumps the version once', async () => {
    const s = setup({ pending: [pend(1)], items: [item(1, { version: 4 })] }); await s.service.sweep(s.ctxAt('12:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ version: 5, alert_level: 'breached' });
  });
  it('an existing clock is never re-created and the catalog is not asked again (segment and target are frozen on the row)', async () => {
    const s = setup({ pending: [pend(1)], items: [item(1)] }); const c = s.ctxAt('09:00:00'); await s.service.sweep(c.ctx);
    expect(c.catalog.getTestCalls).toEqual([]); expect(s.fake.state.items).toHaveLength(1); expect(s.fake.ops()).not.toContain('insertItems');
  });
  it('stopped, cancelled and orphan_closed clocks ignore sweeps entirely: no revive, no level, no event, no write', async () => {
    const stopped = item(1, { state: 'stopped', stopped_at: T('11:30:00'), stop_source: 'verified_event', alert_level: 'warning', expires_at: T('11:30:00', '2027-12-10') });
    const cancelled = item(2, { state: 'cancelled', expires_at: T('09:00:00', '2027-12-10') });
    const orphan = totalItem(3, { state: 'orphan_closed', expires_at: T('09:00:00', '2027-12-10') });
    const s = setup({ pending: [pend(1), pend(2), pend(3, { test_id: TST(2) })], items: [stopped, cancelled, orphan] }); await s.service.sweep(s.ctxAt('20:00:00').ctx);
    expect(s.fake.state.items.map((i) => [i.state, i.alert_level, i.version])).toEqual([['stopped', 'warning', 1], ['cancelled', 'none', 1], ['orphan_closed', 'none', 1]]); expect(s.fake.state.events).toEqual([]);
  });
});

describe('sweep: tenant switch, targets and the catalog', () => {
  it('tat_alerts_enabled = false: the sweep returns the all-zero result and reads nothing at all', async () => {
    const s = setup({ pending: [pend(1)] }, {}, { tatAlertsEnabled: false }); const res = await s.service.sweep(s.ctxAt('12:00:00').ctx);
    expect(s.fake.calls).toEqual([]); expect(res).toMatchObject(ZERO);
  });
  it('settings.ensure runs first on the job tx with the job tenant and the actor id (§12.1)', async () => {
    const s = setup({ pending: [pend(1)] }); const c = s.ctxAt('09:00:00'); await s.service.sweep(c.ctx);
    expect(s.st.calls[0]).toMatchObject({ tx: c.ctx.tx, who: { tenantId: TENANT_A, actorId: c.ctx.actor.id } });
  });
  it('AC-14.5 / T8: an item without a target gets no clock and no event, even when the repo hands it over', async () => {
    const s = setup({}); s.fake.repo.listPending = async () => [pend(1, { tat_target_seconds: null })]; await s.service.sweep(s.ctxAt('12:00:00').ctx);
    expect(s.fake.state.items).toEqual([]); expect(s.fake.state.events).toEqual([]);
  });
  it('the segment comes from CatalogPort.getTest (ONE call per distinct test, with a valid asOf instant); absent tatTargetSegment = within_lab', async () => {
    const s = setup({ pending: [pend(1), pend(2), pend(3, { test_id: TST(2) }), pend(4, { test_id: TST(3) })], ordered: [{ order_id: ORD(3), ordered_at: T('08:00:00') }] }); const c = s.ctxAt('09:00:00'); await s.service.sweep(c.ctx);
    expect(s.fake.itemOf(1)!.segment).toBe('within_lab'); expect(s.fake.itemOf(2)!.segment).toBe('within_lab'); expect(s.fake.itemOf(3)!.segment).toBe('total'); expect(s.fake.itemOf(4)!.segment).toBe('within_lab');
    expect(c.catalog.getTestCalls.map((x) => x.testId).sort()).toEqual([TST(1), TST(2), TST(3)].sort());
    for (const x of c.catalog.getTestCalls) expect(Number.isNaN(Date.parse(String(x.asOf)))).toBe(false);
  });
  it('items of another tenant never reach the sweep: every repo call carries the job tenant and the job tx', async () => {
    const s = setup({ pending: [pend(1), { ...pend(2), tenant_id: TENANT_B }], items: [{ ...item(2), tenant_id: TENANT_B }] }); const c = s.ctxAt('12:00:00'); await s.service.sweep(c.ctx);
    for (const call of s.fake.calls) { expect(call.tenantId, call.op).toBe(TENANT_A); expect(call.tx, call.op).toBe(c.ctx.tx); }
    expect(s.fake.state.items.filter((i) => i.tenant_id === TENANT_B).map((i) => i.version)).toEqual([1]); expect(s.fake.state.items.filter((i) => i.tenant_id === TENANT_A)).toHaveLength(1);
  });
  it('a worker method asks no permission (system actor) and writes created_by / updated_by = the actor id', async () => {
    const s = setup({ pending: [pend(1)] }); const c = s.ctxAt('12:00:00'); await s.service.sweep(c.ctx);
    expect(c.asserted).toEqual([]); for (const call of s.fake.calls.filter((x) => ['insertItems', 'updateItems', 'insertAlertEvents'].includes(x.op))) expect(call.args[0], call.op).toBe(c.ctx.actor.id);
  });
  it('a concurrent creator wins the insert race (ON CONFLICT DO NOTHING returns nothing): no throw, no orphan event rows, nothing counted as created', async () => {
    const s = setup({ pending: [pend(1), pend(2)] }, { raceInsert: (k) => k.order_item_id === OIT(1) }); const res = await s.service.sweep(s.ctxAt('12:00:00').ctx);
    expect(s.fake.state.items.map((i) => i.order_item_id)).toEqual([OIT(2)]); expect(s.fake.state.events.every((e) => e.tat_item_id === s.fake.itemOf(2)!.id)).toBe(true); expect(res.created).toBe(1);
  });
  it('a repo failure rejects the whole sweep (the job retries; nothing is swallowed)', async () => {
    const s = setup({ pending: [pend(1)] }, { failOn: { insertItems: new Error('db down') } }); expect(await rejection(s.service.sweep(s.ctxAt('12:00:00').ctx))).toBeInstanceOf(Error);
  });
});

describe('sweep: total segment start (AC-14.3, vectors T7, T13, T14; 08 A17 D-59)', () => {
  const total = (o: Partial<ReturnType<typeof pend>> = {}) => pend(1, { test_id: TST(2), priority: 'urgent', tat_target_seconds: 7200, received_at: null, item_status: 'ordered', ...o });
  it('T13: the view has registered_at 07:58, the earliest specimen ordered_at is 08:00: started_at 07:58, start_basis registered_at', async () => {
    const s = setup({ pending: [total()], registered: [{ order_id: ORD(1), registered_at: T('07:58:00') }], ordered: [{ order_id: ORD(1), ordered_at: T('08:00:00') }] }); await s.service.sweep(s.ctxAt('08:10:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ segment: 'total', state: 'running', started_at: T('07:58:00'), start_basis: 'registered_at', priority: 'urgent', target_seconds: 7200 });
  });
  it('T14: the view has no row for the order yet: started_at 08:00, start_basis specimen_ordered_at', async () => {
    const s = setup({ pending: [total()], ordered: [{ order_id: ORD(1), ordered_at: T('08:00:00') }] }); await s.service.sweep(s.ctxAt('08:10:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ segment: 'total', state: 'running', started_at: T('08:00:00'), start_basis: 'specimen_ordered_at' });
  });
  it('a total clock runs from registration even before the specimen is received (received_at null)', async () => {
    const s = setup({ pending: [total()], registered: [{ order_id: ORD(1), registered_at: T('07:58:00') }] }); await s.service.sweep(s.ctxAt('08:10:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'running', started_at: T('07:58:00') });
  });
  it('T7: urgent target 7,200 s, ordered 08:00: warning raised at 09:36 (5,760 s), never earlier, level history [warning]', async () => {
    const seed = { pending: [total()], ordered: [{ order_id: ORD(1), ordered_at: T('08:00:00') }] };
    const early = setup(seed); await early.service.sweep(early.ctxAt('09:35:59').ctx); expect(early.fake.itemOf(1)!.alert_level).toBe('none');
    const s = setup(seed); await s.service.sweep(s.ctxAt('09:36:00').ctx); expect(s.fake.eventsOf(s.fake.itemOf(1)!.id).map((e) => e.level)).toEqual(['warning']);
  });
  it('the basis and the start are never changed later: a view row that appears after creation does not move started_at / start_basis', async () => {
    const s = setup({ pending: [total()], ordered: [{ order_id: ORD(1), ordered_at: T('08:00:00') }] }); await s.service.sweep(s.ctxAt('08:10:00').ctx);
    s.fake.state.registered.push({ tenant_id: TENANT_A, order_id: ORD(1), registered_at: T('07:58:00') }); await s.service.sweep(s.ctxAt('08:20:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ started_at: T('08:00:00'), start_basis: 'specimen_ordered_at', version: 1 });
  });
  it('neither a registered_at nor a specimen ordered_at: no clock yet (and no throw); the next sweep creates it once a start exists', async () => {
    const s = setup({ pending: [total()] }); await s.service.sweep(s.ctxAt('08:10:00').ctx); expect(s.fake.state.items).toEqual([]);
    s.fake.state.ordered.push({ tenant_id: TENANT_A, order_id: ORD(1), ordered_at: T('08:00:00') }); await s.service.sweep(s.ctxAt('08:11:00').ctx); expect(s.fake.itemOf(1)).toMatchObject({ start_basis: 'specimen_ordered_at' });
  });
  it('the reporting view and the timeline are read ONLY for orders that need a NEW total clock, and the timeline only for orders the view did not return', async () => {
    const s = setup({ pending: [total(), pend(2, { test_id: TST(2) }), pend(3, { test_id: TST(2) }), pend(4)], items: [totalItem(3)], registered: [{ order_id: ORD(1), registered_at: T('07:58:00') }], ordered: [{ order_id: ORD(2), ordered_at: T('08:00:00') }] });
    await s.service.sweep(s.ctxAt('08:10:00').ctx);
    const arg = (op: string) => (s.fake.calls.find((c) => c.op === op)?.args[0] as string[] | undefined)?.slice().sort();
    expect(arg('listTotalStarts')).toEqual([ORD(1), ORD(2)].sort()); expect(arg('listEarliestOrdered')).toEqual([ORD(2)]);
  });
  it('a sweep without any new total clock never touches the reporting view or the timeline', async () => {
    const s = setup({ pending: [pend(1)], items: [item(1)] }); await s.service.sweep(s.ctxAt('09:00:00').ctx); expect(s.fake.ops()).not.toContain('listTotalStarts'); expect(s.fake.ops()).not.toContain('listEarliestOrdered');
  });
  it('AC-14.4: a total clock continues over a recollection: the specimen id follows, started_at, restart_count and level stay', async () => {
    const s = setup({ pending: [pend(1, { test_id: TST(2), specimen_id: SPC(9), received_at: T('12:30:00') })], items: [totalItem(1, { alert_level: 'warning', restart_count: 0 })] }); await s.service.sweep(s.ctxAt('13:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ specimen_id: SPC(9), started_at: T('08:00:00'), restart_count: 0, alert_level: 'breached' });
  });
});

describe('sweep: within-lab restart on recollection (AC-14.4, vector T6)', () => {
  const seed = (): TatSeed => ({ pending: [pend(1, { specimen_id: SPC(9), received_at: T('12:30:00') })],
    items: [item(1, { version: 3, alert_level: 'breached', acknowledged_level: 'breached', acknowledged_at: T('10:00:00'), acknowledged_by: MEMB(1) })],
    events: [{ tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', raised_at: T('11:12:00'), elapsed_seconds: 11_520, restart_no: 0 }, { tat_item_id: TAT(1), centre_id: CEN(1), level: 'breached', raised_at: T('12:00:00'), elapsed_seconds: 14_400, restart_no: 0 }] });
  it('the clock restarts at the new specimen\'s received_at, the alert level is reset, the acknowledgement is cleared, restart_count 1, the old level events stay', async () => {
    const s = setup(seed()); await s.service.sweep(s.ctxAt('13:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'running', specimen_id: SPC(9), started_at: T('12:30:00'), restart_count: 1, alert_level: 'none', acknowledged_level: null, acknowledged_at: null, acknowledged_by: null, version: 4 });
    expect(s.fake.eventsOf(TAT(1))).toHaveLength(2);
  });
  it('a later crossing raises a NEW warning event under restart_no 1 (the once-key is per restart)', async () => {
    const s = setup(seed()); await s.service.sweep(s.ctxAt('13:00:00').ctx); await s.service.sweep(s.ctxAt('15:42:00').ctx);
    expect(s.fake.eventsOf(TAT(1)).map((e) => [e.level, e.restart_no])).toEqual([['warning', 0], ['breached', 0], ['warning', 1]]);
  });
  it('recollection specimen not received yet: not_started, restart_count 1, no start, level none; start_basis stays specimen_received_at', async () => {
    const sd = seed(); sd.pending![0]!.received_at = null; const s = setup(sd); await s.service.sweep(s.ctxAt('13:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'not_started', started_at: null, start_basis: 'specimen_received_at', restart_count: 1, alert_level: 'none', specimen_id: SPC(9) });
  });
});

describe('sweep: items that leave the pending view (§9.3 steps 4-5; vectors T9, T10)', () => {
  it('T9: a running within_lab item that left the view with no verified event is cancelled, with expires_at = now + 400 days', async () => {
    const s = setup({ items: [item(1)] }); await s.service.sweep(s.ctxAt('11:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'cancelled', expires_at: plus(T('11:00:00'), 400 * DAY_MS) }); expect(s.fake.itemOf(1)!.version).toBe(2);
  });
  it('a not_started within_lab item that left the view is cancelled; a total item without first_verified_at is cancelled', async () => {
    const s = setup({ items: [item(1, { state: 'not_started', started_at: null }), totalItem(2)] }); const res = await s.service.sweep(s.ctxAt('11:00:00').ctx);
    expect(s.fake.state.items.map((i) => i.state)).toEqual(['cancelled', 'cancelled']); expect(res.cancelled).toBe(2);
  });
  it('a total item with first_verified_at keeps running with in_pending_view = false and left_pending_view_at = now', async () => {
    const s = setup({ items: [totalItem(1, { first_verified_at: T('10:00:00') })] }); await s.service.sweep(s.ctxAt('10:30:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'running', in_pending_view: false, left_pending_view_at: T('10:30:00'), expires_at: null });
  });
  it('T10: that total clock still breaches while out of the view (12:00) and left_pending_view_at is not moved by later sweeps', async () => {
    const s = setup({ items: [totalItem(1, { first_verified_at: T('10:00:00'), in_pending_view: false, left_pending_view_at: T('10:30:00') })] }); await s.service.sweep(s.ctxAt('12:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'running', alert_level: 'breached', left_pending_view_at: T('10:30:00') }); expect(s.fake.eventsOf(TAT(1)).map((e) => e.level)).toEqual(['warning', 'breached']);
  });
  it('orphan close is strictly after tat_orphan_close_hours (72 h): at exactly 72 h still running, one second later orphan_closed with expires_at', async () => {
    const left = T('10:30:00'); const seed = { items: [totalItem(1, { first_verified_at: T('10:00:00'), in_pending_view: false, left_pending_view_at: left, alert_level: 'escalated' })] };
    const at72 = setup(seed); await at72.service.sweep(makeTatCtx({ now: plus(left, 72 * 3_600_000) }).ctx); expect(at72.fake.itemOf(1)!.state).toBe('running');
    const past = setup(seed); const now = plus(left, 72 * 3_600_000 + 1000); const res = await past.service.sweep(makeTatCtx({ now }).ctx);
    expect(past.fake.itemOf(1)).toMatchObject({ state: 'orphan_closed', expires_at: plus(now, 400 * DAY_MS) }); expect(res.orphanClosed).toBe(1);
  });
  it('TC8: a within_lab item shown as verified in the view with no verified event yet is stopped by the sweep (stop_source sweep, stopped_at = now)', async () => {
    const s = setup({ pending: [pend(1, { item_status: 'verified' })], items: [item(1)] }); const res = await s.service.sweep(s.ctxAt('11:00:00').ctx);
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'stopped', stop_source: 'sweep', stopped_at: T('11:00:00'), expires_at: plus(T('11:00:00'), 400 * DAY_MS) }); expect(res.stopped).toBe(1);
  });
});

describe('sweep: cost is bounded and independent of the item count (done_when: p95 <= 2 s per tenant on 10x seed)', () => {
  const big = (n: number): TatSeed => ({ pending: Array.from({ length: n }, (_x, i) => pend(i + 1, { received_at: T('08:00:00') })), items: Array.from({ length: Math.floor(n / 2) }, (_x, i) => item(i + 1)) });
  it('the number of repo statements per sweep does not grow with the item count (batched reads, one insert, one update, one touch, one event insert)', async () => {
    const small = setup(big(10)); await small.service.sweep(small.ctxAt('12:00:00').ctx);
    const large = setup(big(5000)); await large.service.sweep(large.ctxAt('12:00:00').ctx);
    expect(large.fake.calls.length).toBe(small.fake.calls.length); expect(large.fake.calls.length).toBeLessThanOrEqual(12);
    for (const op of ['insertItems', 'updateItems', 'touchSeen', 'insertAlertEvents', 'findItems']) expect(large.fake.ops().filter((o) => o === op).length, op).toBeLessThanOrEqual(1);
  });
  it('a sweep over 5,000 pending items (10x a 500-item tenant) with level changes completes in well under 2 s of service time', async () => {
    const s = setup(big(5000)); const c = s.ctxAt('12:00:00'); const t0 = performance.now(); const res = await s.service.sweep(c.ctx); const ms = performance.now() - t0;
    expect(res.seen).toBe(5000); expect(ms).toBeLessThan(2000); expect(s.fake.state.items).toHaveLength(5000);
  });
  it('the catalog is asked once per distinct test, not once per item', async () => {
    const s = setup(big(2000)); const c = s.ctxAt('12:00:00'); await s.service.sweep(c.ctx); expect(c.catalog.getTestCalls).toHaveLength(1);
  });
});

describe('refreshOrder (specimen events; §9.3 steps 1-4 for ONE order)', () => {
  it('reads the pending view for that order only and never touches or cancels items of other orders', async () => {
    const s = setup({ pending: [pend(1)], items: [item(1), item(2)] }); const c = s.ctxAt('09:00:00'); await s.service.refreshOrder(c.ctx, { orderId: ORD(1) });
    expect(s.fake.calls.find((x) => x.op === 'listPending')!.args[0]).toEqual({ orderId: ORD(1) }); expect(s.fake.itemOf(2)).toMatchObject({ state: 'running', version: 1 });
  });
  it('the order\'s own item that left the view is cancelled (T9 scoped to the order)', async () => {
    const s = setup({ items: [item(1), item(2)] }); await s.service.refreshOrder(s.ctxAt('09:00:00').ctx, { orderId: ORD(1) }); expect(s.fake.itemOf(1)!.state).toBe('cancelled'); expect(s.fake.itemOf(2)!.state).toBe('running');
  });
  it('T6 through a refresh: a rejected specimen and a recollection specimen received 12:30 restart the clock at 12:30 (restart_count 1)', async () => {
    const s = setup({ pending: [pend(1, { specimen_id: SPC(9), received_at: T('12:30:00') })], items: [item(1, { alert_level: 'breached' })] }); await s.service.refreshOrder(s.ctxAt('13:00:00').ctx, { orderId: ORD(1) });
    expect(s.fake.itemOf(1)).toMatchObject({ started_at: T('12:30:00'), restart_count: 1, alert_level: 'none', specimen_id: SPC(9) });
  });
  it('creates the clocks of a newly received order and raises levels like the sweep does', async () => {
    const s = setup({ pending: [pend(1), pend(2)] }); await s.service.refreshOrder(s.ctxAt('12:00:00').ctx, { orderId: ORD(1) });
    expect(s.fake.state.items.map((i) => i.order_id)).toEqual([ORD(1)]); expect(s.fake.itemOf(1)!.alert_level).toBe('breached');
  });
  it('tat_alerts_enabled = false: a no-op; a non-uuid order id rejects before any repo call', async () => {
    const off = setup({ pending: [pend(1)] }, {}, { tatAlertsEnabled: false }); await off.service.refreshOrder(off.ctxAt('09:00:00').ctx, { orderId: ORD(1) }); expect(off.fake.calls).toEqual([]);
    const s = setup(); for (const bad of ["x'; DROP TABLE quality.tat_items;--", '', undefined, 7]) expect(await rejection(s.service.refreshOrder(s.ctxAt('09:00:00').ctx, { orderId: bad as never })), String(bad)).toBeInstanceOf(Error);
    expect(s.fake.calls).toEqual([]);
  });
});

describe('applyVerified (lab.result.verified.v1 stop logic; vectors T5, T11)', () => {
  const v = (n: number, at: string) => ({ orderItemId: OIT(n), testId: TST(1), verifiedAt: at });
  it('T5: a running within_lab clock stops at verified_at (not at now), stop_source verified_event, expires_at = verified_at + 400 d, level history kept, open list empty', async () => {
    const s = setup({ items: [item(1, { alert_level: 'warning' })], events: [{ tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', raised_at: T('11:12:00'), elapsed_seconds: 11_520, restart_no: 0 }] });
    await s.service.applyVerified(s.ctxAt('12:00:00').ctx, v(1, T('11:30:00')));
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'stopped', stopped_at: T('11:30:00'), stop_source: 'verified_event', expires_at: plus(T('11:30:00'), 400 * DAY_MS), alert_level: 'warning' });
    expect(s.fake.eventsOf(TAT(1)).map((e) => e.level)).toEqual(['warning']);
    const list = await s.service.listTatAlerts(makeTatCtx({ now: T('12:00:00') }).ctx, {}); expect(list.body.data).toEqual([]);
  });
  it('T11: a late event after the item was cancelled still stops it with verified_at (correction); a not_started clock stops too', async () => {
    const s = setup({ items: [item(1, { state: 'cancelled', expires_at: T('09:00:00', '2027-12-10') }), item(2, { state: 'not_started', started_at: null })] });
    await s.service.applyVerified(s.ctxAt('12:00:00').ctx, v(1, T('11:30:00'))); await s.service.applyVerified(s.ctxAt('12:00:00').ctx, v(2, T('11:31:00')));
    expect(s.fake.state.items.map((i) => [i.state, i.stopped_at, i.stop_source])).toEqual([['stopped', T('11:30:00'), 'verified_event'], ['stopped', T('11:31:00'), 'verified_event']]);
  });
  it('the earliest verified_at wins: a later duplicate is a no-op (no write), an earlier correction moves stopped_at back', async () => {
    const s = setup({ items: [item(1, { state: 'stopped', stopped_at: T('11:30:00'), stop_source: 'verified_event', expires_at: plus(T('11:30:00'), 400 * DAY_MS) })] });
    s.fake.calls.length = 0; await s.service.applyVerified(s.ctxAt('12:00:00').ctx, v(1, T('11:45:00'))); expect(s.fake.ops()).not.toContain('updateItems'); expect(s.fake.itemOf(1)).toMatchObject({ stopped_at: T('11:30:00'), version: 1 });
    await s.service.applyVerified(s.ctxAt('12:00:00').ctx, v(1, T('11:20:00'))); expect(s.fake.itemOf(1)).toMatchObject({ stopped_at: T('11:20:00'), state: 'stopped' });
  });
  it('a total clock only records first_verified_at (earliest) and keeps running; it is not stopped by a verification', async () => {
    const s = setup({ items: [totalItem(1)] });
    await s.service.applyVerified(s.ctxAt('12:00:00').ctx, { orderItemId: OIT(1), testId: TST(2), verifiedAt: T('10:00:00') }); await s.service.applyVerified(s.ctxAt('12:00:00').ctx, { orderItemId: OIT(1), testId: TST(2), verifiedAt: T('10:30:00') });
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'running', first_verified_at: T('10:00:00'), stopped_at: null });
  });
  it('no clock for the (order item, test): a no-op without error and without any write; a verified result of test B does not stop the clock of test A of the same item', async () => {
    const s = setup({ items: [item(1)] }); await s.service.applyVerified(s.ctxAt('12:00:00').ctx, v(7, T('11:30:00'))); await s.service.applyVerified(s.ctxAt('12:00:00').ctx, { orderItemId: OIT(1), testId: TST(3), verifiedAt: T('11:30:00') });
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'running', version: 1 }); expect(s.fake.ops()).not.toContain('updateItems');
  });
  it('tenant from ctx only; no permission check; hostile ids reject before any repo call', async () => {
    const s = setup({ items: [item(1)] }); const c = s.ctxAt('12:00:00'); await s.service.applyVerified(c.ctx, v(1, T('11:30:00')));
    expect(c.asserted).toEqual([]); for (const call of s.fake.calls) expect(call.tenantId).toBe(TENANT_A);
    const h = setup(); for (const bad of [{ orderItemId: "x'; --", testId: TST(1), verifiedAt: T('11:30:00') }, { orderItemId: OIT(1), testId: TST(1), verifiedAt: 'yesterday' }, { orderItemId: OIT(1), testId: undefined, verifiedAt: T('11:30:00') }]) expect(await rejection(h.service.applyVerified(h.ctxAt('12:00:00').ctx, bad as never))).toBeInstanceOf(Error);
    expect(h.fake.calls).toEqual([]);
  });
});

describe('applyRelease (reporting.report.released.v1; vectors T12; AC-14.3)', () => {
  const rel = (o: Record<string, unknown> = {}) => ({ orderId: ORD(1), reportKind: 'final', releasedAt: T('09:50:00'), ...o });
  const two = () => setup({ items: [totalItem(1), totalItem(11, { order_id: ORD(1) }), item(21, { order_id: ORD(1) }), totalItem(2)] });   // 1 and 11: total of order 1 (families A and B); 21: within_lab of order 1; 2: another order
  it('T12: final with order_item_ids [I1] stops only I1 (stop_source release_event, stopped_at = released_at, expires_at +400 d); I2 keeps running', async () => {
    const s = two(); await s.service.applyRelease(s.ctxAt('10:00:00').ctx, rel({ orderItemIds: [OIT(1)] }));
    expect(s.fake.itemOf(1)).toMatchObject({ state: 'stopped', stop_source: 'release_event', stopped_at: T('09:50:00'), expires_at: plus(T('09:50:00'), 400 * DAY_MS) });
    expect(s.fake.itemOf(11)!.state).toBe('running'); expect(s.fake.itemOf(21)!.state).toBe('running'); expect(s.fake.itemOf(2)!.state).toBe('running');
  });
  it('partial with order_item_ids stops those items too; a partial WITHOUT the ids stops nothing', async () => {
    const a = two(); await a.service.applyRelease(a.ctxAt('10:00:00').ctx, rel({ reportKind: 'partial', orderItemIds: [OIT(11)] })); expect(a.fake.itemOf(11)!.state).toBe('stopped'); expect(a.fake.itemOf(1)!.state).toBe('running');
    const b = two(); await b.service.applyRelease(b.ctxAt('10:00:00').ctx, rel({ reportKind: 'partial' })); expect(b.fake.state.items.every((i) => i.state === 'running')).toBe(true);
  });
  it('final WITHOUT order_item_ids stops every total item of the order, never a within_lab item and never another order\'s item', async () => {
    const s = two(); await s.service.applyRelease(s.ctxAt('10:00:00').ctx, rel());
    expect(s.fake.itemOf(1)!.state).toBe('stopped'); expect(s.fake.itemOf(11)!.state).toBe('stopped'); expect(s.fake.itemOf(21)!.state).toBe('running'); expect(s.fake.itemOf(2)!.state).toBe('running');
  });
  it.each(['preliminary', 'amended', 'addendum', 'brand_new_kind', ''])('report_kind %j is a no-op even with order_item_ids (x-extensible: unknown kinds stop nothing)', async (kind) => {
    const s = two(); s.fake.calls.length = 0; await s.service.applyRelease(s.ctxAt('10:00:00').ctx, rel({ reportKind: kind, orderItemIds: [OIT(1), OIT(11)] }));
    expect(s.fake.state.items.every((i) => i.state === 'running' && i.version === 1)).toBe(true); expect(s.fake.ops()).not.toContain('updateItems');
  });
  it('an item id of ANOTHER order in order_item_ids is ignored (the order scopes the stop)', async () => {
    const s = two(); await s.service.applyRelease(s.ctxAt('10:00:00').ctx, rel({ orderItemIds: [OIT(2)] })); expect(s.fake.itemOf(2)!.state).toBe('running');
  });
  it('already stopped / cancelled items are not rewritten (duplicate delivery is a no-op)', async () => {
    const s = setup({ items: [totalItem(1, { state: 'stopped', stopped_at: T('09:00:00'), stop_source: 'release_event', expires_at: plus(T('09:00:00'), 400 * DAY_MS) }), totalItem(11, { order_id: ORD(1), state: 'cancelled' })] });
    s.fake.calls.length = 0; await s.service.applyRelease(s.ctxAt('10:00:00').ctx, rel()); await s.service.applyRelease(s.ctxAt('10:00:00').ctx, rel());
    expect(s.fake.ops()).not.toContain('updateItems'); expect(s.fake.itemOf(1)).toMatchObject({ stopped_at: T('09:00:00'), version: 1 });
  });
  it('a stop is one batched update for all affected rows; tenant from ctx only; no permission check', async () => {
    const s = two(); const c = s.ctxAt('10:00:00'); await s.service.applyRelease(c.ctx, rel()); expect(s.fake.ops().filter((o) => o === 'updateItems')).toHaveLength(1); expect(c.asserted).toEqual([]);
    for (const call of s.fake.calls) expect(call.tenantId).toBe(TENANT_A);
  });
});

describe('purgeExpired (P-18(c))', () => {
  it('calls the repo delete ONCE with the job tenant and ctx.now(); returns the deleted count; asks no permission', async () => {
    const s = setup({ items: [item(1, { state: 'stopped', expires_at: T('01:00:00') })] }); const c = s.ctxAt('02:40:00'); const res = await s.service.purgeExpired(c.ctx);
    const dels = s.fake.calls.filter((x) => x.op === 'deleteExpired'); expect(dels).toHaveLength(1); expect(dels[0]).toMatchObject({ tenantId: TENANT_A, args: [T('02:40:00')] }); expect(res).toEqual({ deleted: 1 }); expect(c.asserted).toEqual([]);
  });
  it('a row with alert events or acks is kept (class A children), a row not yet expired is kept, an expired childless row goes', async () => {
    const exp = T('01:00:00');
    const s = setup({ items: [item(1, { expires_at: exp }), item(2, { expires_at: exp }), item(3, { expires_at: exp }), item(4, { expires_at: T('23:00:00') }), item(5, { expires_at: null })],
      events: [{ tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', raised_at: exp, elapsed_seconds: 1, restart_no: 0 }], acks: [{ tat_item_id: TAT(2), centre_id: CEN(1), level: 'warning', note: null, acknowledged_by_membership_id: MEMB(1), created_at: exp, created_by: MEMB(1) }] });
    const res = await s.service.purgeExpired(s.ctxAt('02:40:00').ctx);
    expect(res).toEqual({ deleted: 1 }); expect(s.fake.state.items.map((i) => i.id).sort()).toEqual([TAT(1), TAT(2), TAT(4), TAT(5)].sort());
  });
});

// ---- endpoints --------------------------------------------------------------------------------------------------------------------------------------
const alerts = () => ({ items: [
  item(1, { alert_level: 'warning', started_at: T('08:00:00') }), item(2, { alert_level: 'escalated', started_at: T('05:00:00') }), item(3, { alert_level: 'breached', started_at: T('07:00:00'), centre_id: CEN(2), priority: 'urgent' }),
  totalItem(4, { alert_level: 'warning', started_at: T('07:30:00'), department_id: null }), item(5, { alert_level: 'none' }), item(6, { alert_level: 'breached', state: 'stopped', stopped_at: T('11:00:00'), stop_source: 'verified_event' }),
  { ...item(7, { alert_level: 'escalated' }), tenant_id: TENANT_B }] as TatSeed['items'] });
const codes = (r: any) => r.body.data.map((d: any) => d.tat_item_id);
describe('#48 listTatAlerts (AC-14.1, 14.6-14.8)', () => {
  it('asserts quality.tat_alert.read FIRST (before any repo call): without it auth.forbidden', async () => {
    const s = setup(alerts()); const c = makeTatCtx({ now: T('11:30:00'), roles: noRights }); expect(code(await rejection(s.service.listTatAlerts(c.ctx, {})))).toBe('auth.forbidden'); expect(s.fake.calls).toEqual([]);
    const ok = makeTatCtx({ now: T('11:30:00') }); await s.service.listTatAlerts(ok.ctx, {}); expect(ok.asserted[0]).toMatchObject({ permission: 'quality.tat_alert.read' });
  });
  it('the open list = running clocks at warning or above of the job tenant: not "none", not stopped, not another tenant; default order escalated, breached, warning (pct desc inside a level)', async () => {
    const s = setup(alerts()); const r = await s.service.listTatAlerts(makeTatCtx({ now: T('11:30:00') }).ctx, {});
    expect(r.status).toBe(200); expect(codes(r)).toEqual([TAT(2), TAT(3), TAT(4), TAT(1)]); expect(r.version).toBeUndefined();
    expect(r.body.generated_at).toBe(T('11:30:00')); expect(r.body.page).toMatchObject({ limit: 50 });
  });
  it('a DTO is exactly the contract: required keys present, nothing outside the allowlist, no undefined values, no tenant_id / internal columns', async () => {
    const s = setup(alerts()); const r = await s.service.listTatAlerts(makeTatCtx({ now: T('11:30:00') }).ctx, {});
    for (const d of r.body.data) {
      expect(Object.keys(d).filter((k) => !DTO_KEYS.includes(k))).toEqual([]);
      for (const k of ['tat_item_id', 'version', 'order_id', 'order_item_id', 'test_id', 'test_code', 'centre_id', 'priority', 'segment', 'segment_label', 'start_basis', 'target_seconds', 'elapsed_seconds', 'pct_of_target', 'alert_level', 'state']) expect(d[k], k).not.toBeUndefined();
      expect(Object.values(d).includes(undefined)).toBe(false); expect(JSON.stringify(d)).not.toMatch(/tenant_id|last_seen|created_by|updated_by|in_pending_view/);
    }
  });
  it('AC-14.8: every figure names its segment (label starts "Within lab" / "Total"); elapsed and pct are computed at now (12,600 s of 14,400 = 87 %)', async () => {
    const s = setup(alerts()); const r = await s.service.listTatAlerts(makeTatCtx({ now: T('11:30:00') }).ctx, {}); const by = (id: string) => r.body.data.find((d: any) => d.tat_item_id === id);
    expect(by(TAT(1)).segment_label).toMatch(/^Within lab/); expect(by(TAT(4)).segment_label).toMatch(/^Total/); expect(by(TAT(1)).segment_label.length).toBeLessThanOrEqual(120);
    expect(by(TAT(1))).toMatchObject({ test_code: 'CBC', segment: 'within_lab', start_basis: 'specimen_received_at', started_at: T('08:00:00'), elapsed_seconds: 12_600, pct_of_target: 87, state: 'running', version: 1 });
    expect(by(TAT(4))).toMatchObject({ test_code: 'ESR', segment: 'total', start_basis: 'registered_at', elapsed_seconds: 14_400, pct_of_target: 100 });   // department_id of a null-department item: contract lists it as required but non-nullable — not pinned (see notes)
  });
  it('one CatalogPort.getTest per DISTINCT test of the page (not per row)', async () => {
    const s = setup(alerts()); const c = makeTatCtx({ now: T('11:30:00') }); await s.service.listTatAlerts(c.ctx, {}); expect(c.catalog.getTestCalls.map((x) => x.testId).sort()).toEqual([TST(1), TST(2)].sort());
  });
  it.each([
    ['level csv', { level: 'breached,escalated' }, [TAT(2), TAT(3)]], ['segment', { segment: 'total' }, [TAT(4)]], ['priority', { priority: 'urgent' }, [TAT(3)]], ['centre_id', { centreId: CEN(2) }, [TAT(3)]], ['department_id', { departmentId: DEP_1() }, [TAT(2), TAT(1)]],
  ])('filter %s', async (_n, input, ids) => {
    const s = setup(alerts()); const r = await s.service.listTatAlerts(makeTatCtx({ now: T('11:30:00') }).ctx, input); expect(codes(r)).toEqual(ids);
  });
  it('sort -pct_of_target and started_at', async () => {
    const s = setup(alerts()); const c = makeTatCtx({ now: T('11:30:00') });
    expect(codes(await s.service.listTatAlerts(c.ctx, { sort: '-pct_of_target' }))).toEqual([TAT(2), TAT(3), TAT(4), TAT(1)]); expect(codes(await s.service.listTatAlerts(c.ctx, { sort: 'started_at' }))).toEqual([TAT(2), TAT(3), TAT(4), TAT(1)]);
  });
  it('paging: limit 2 returns next_cursor and the second page continues without overlap; the default limit is 50, the maximum 200', async () => {
    const s = setup(alerts()); const c = makeTatCtx({ now: T('11:30:00') });
    const p1 = await s.service.listTatAlerts(c.ctx, { limit: 2 }); expect(codes(p1)).toEqual([TAT(2), TAT(3)]); expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await s.service.listTatAlerts(c.ctx, { limit: 2, cursor: p1.body.page.next_cursor }); expect(codes(p2)).toEqual([TAT(4), TAT(1)]); expect(p2.body.page.next_cursor).toBeUndefined();
    expect(s.fake.calls.filter((x) => x.op === 'listAlerts')[0]!.args[1]).toMatchObject({ limit: 2 }); expect(s.fake.calls.at(-1)!.args[1]).toMatchObject({ limit: 2, cursor: p1.body.page.next_cursor });
    await s.service.listTatAlerts(c.ctx, {}); expect(s.fake.calls.at(-1)!.args[1]).toMatchObject({ limit: 50 });
  });
  it.each([['limit 201', { limit: 201 }], ['limit 0', { limit: 0 }], ['level none', { level: 'none' }], ['level garbage', { level: 'warning,,x' }], ['segment', { segment: 'pre_analytical' }], ['priority', { priority: 'stat' }], ['sort', { sort: 'tenant_id' }],
    ['acknowledged string', { acknowledged: 'yes' }], ['centre_id', { centreId: "x' OR '1'='1" }], ['department_id', { departmentId: 7 }]])('hostile or invalid input (%s) -> 400 common.validation_failed before any repo call', async (_n, input) => {
    const s = setup(alerts()); const e = await rejection(s.service.listTatAlerts(makeTatCtx({ now: T('11:30:00') }).ctx, input)); expect(code(e)).toBe('common.validation_failed'); expect(s.fake.calls).toEqual([]);
  });
  it('AC-14.7 / S-02: a centre-scoped reader (RLS) sees only the alerts of their centres; other tenants never', async () => {
    const s = setup(alerts(), { visibleCentres: [CEN(2)] }); expect(codes(await s.service.listTatAlerts(makeTatCtx({ now: T('11:30:00') }).ctx, {}))).toEqual([TAT(3)]);
    const b = setup(alerts()); expect(codes(await b.service.listTatAlerts(makeTatCtx({ now: T('11:30:00'), tenantId: TENANT_B }).ctx, {}))).toEqual([TAT(7)]);
    for (const call of b.fake.calls) expect(call.tenantId).toBe(TENANT_B);
  });
  it('AC-14.6: the acknowledged filter follows the level: an ack at warning covers warning, NOT a later breached alert', async () => {
    const s = setup({ items: [item(1, { alert_level: 'warning', acknowledged_level: 'warning', acknowledged_at: T('11:20:00'), acknowledged_by: MEM }), item(2, { alert_level: 'breached', acknowledged_level: 'warning', acknowledged_at: T('11:20:00'), acknowledged_by: MEM }), item(3, { alert_level: 'warning' })],
      labels: [{ membership_id: MEM, display: 'Synthetic Tech' }] }); const c = makeTatCtx({ now: T('12:30:00') });
    expect(codes(await s.service.listTatAlerts(c.ctx, { acknowledged: true }))).toEqual([TAT(1)]); expect(codes(await s.service.listTatAlerts(c.ctx, { acknowledged: false })).sort()).toEqual([TAT(2), TAT(3)].sort());
    const r = await s.service.listTatAlerts(c.ctx, {}); const d = r.body.data.find((x: any) => x.tat_item_id === TAT(2));
    expect(d).toMatchObject({ acknowledged_level: 'warning', acknowledged_at: T('11:20:00'), acknowledged_by_display: 'Synthetic Tech' });
  });
});
function DEP_1() { return item(1).department_id as string; }

describe('#49 getTatAlert', () => {
  it('asserts quality.tat_alert.read first; unknown id and an id of another tenant -> 404 common.not_found', async () => {
    const s = setup(alerts()); expect(code(await rejection(s.service.getTatAlert(makeTatCtx({ roles: noRights }).ctx, { tatItemId: TAT(1) })))).toBe('auth.forbidden'); expect(s.fake.calls).toEqual([]);
    const c = makeTatCtx({ now: T('11:30:00') }); expect(code(await rejection(s.service.getTatAlert(c.ctx, { tatItemId: TAT(99) })))).toBe('common.not_found'); expect(code(await rejection(s.service.getTatAlert(c.ctx, { tatItemId: TAT(7) })))).toBe('common.not_found');
    expect(c.asserted[0]).toMatchObject({ permission: 'quality.tat_alert.read' });
  });
  it('S-02: an item of a centre the reader cannot see is 404, not 403 and not a leak', async () => {
    const s = setup(alerts(), { visibleCentres: [CEN(1)] }); expect(code(await rejection(s.service.getTatAlert(makeTatCtx({ now: T('11:30:00') }).ctx, { tatItemId: TAT(3) })))).toBe('common.not_found');
  });
  it('a malformed id -> 400 before any repo call', async () => {
    const s = setup(alerts()); expect(code(await rejection(s.service.getTatAlert(makeTatCtx().ctx, { tatItemId: "1' OR '1'='1" })))).toBe('common.validation_failed'); expect(s.fake.calls).toEqual([]);
  });
  it('the detail = the alert DTO + restart_count, first_verified_at, stopped_at, stop_source, level_events (level, raised_at, elapsed_seconds, restart_no) and acknowledgements (level, note, acknowledged_by_display, created_at); ETag version', async () => {
    const s = setup({ items: [item(1, { state: 'stopped', alert_level: 'breached', stopped_at: T('12:30:00'), stop_source: 'verified_event', restart_count: 1, first_verified_at: T('12:30:00'), version: 6 })],
      events: [{ tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', raised_at: T('11:12:00'), elapsed_seconds: 11_520, restart_no: 0 }, { tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', raised_at: T('15:00:00'), elapsed_seconds: 11_520, restart_no: 1 }],
      acks: [{ tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', note: 'Synthetic: queue cleared', acknowledged_by_membership_id: MEM, created_at: T('11:20:00'), created_by: MEM }], labels: [{ membership_id: MEM, display: 'Synthetic Tech' }] });
    const r = await s.service.getTatAlert(makeTatCtx({ now: T('13:00:00') }).ctx, { tatItemId: TAT(1) }); const d = r.body;
    expect(r).toMatchObject({ status: 200, version: 6 }); expect(Object.keys(d).filter((k) => ![...DTO_KEYS, ...DETAIL_EXTRA].includes(k))).toEqual([]);
    expect(d).toMatchObject({ state: 'stopped', restart_count: 1, first_verified_at: T('12:30:00'), stopped_at: T('12:30:00'), stop_source: 'verified_event', elapsed_seconds: 16_200, pct_of_target: 112, version: 6 });
    expect(d.level_events).toEqual([{ level: 'warning', raised_at: T('11:12:00'), elapsed_seconds: 11_520, restart_no: 0 }, { level: 'warning', raised_at: T('15:00:00'), elapsed_seconds: 11_520, restart_no: 1 }]);
    expect(d.acknowledgements).toEqual([{ level: 'warning', note: 'Synthetic: queue cleared', acknowledged_by_display: 'Synthetic Tech', created_at: T('11:20:00') }]); expect(JSON.stringify(d)).not.toContain(MEM);
  });
  it('a running detail with no history still carries empty level_events / acknowledgements arrays; a note-less ack omits `note`', async () => {
    const s = setup({ items: [item(1), item(2, { alert_level: 'warning' })], acks: [{ tat_item_id: TAT(2), centre_id: CEN(1), level: 'warning', note: null, acknowledged_by_membership_id: MEM, created_at: T('11:20:00'), created_by: MEM }] });
    const c = makeTatCtx({ now: T('11:30:00') }); const a = await s.service.getTatAlert(c.ctx, { tatItemId: TAT(1) }); expect(a.body.level_events).toEqual([]); expect(a.body.acknowledgements).toEqual([]); expect(a.body.restart_count).toBe(0);
    const b = await s.service.getTatAlert(c.ctx, { tatItemId: TAT(2) }); expect('note' in b.body.acknowledgements[0]).toBe(false); expect(b.body.acknowledgements[0].acknowledged_by_display).toMatch(/\S/); expect(b.body.acknowledgements[0].acknowledged_by_display).not.toBe(MEM);
  });
});

describe('#50 acknowledgeTatAlert (AC-14.6; S-02, S-03)', () => {
  const input = (o: Record<string, unknown> = {}) => ({ tatItemId: TAT(1), expectedVersion: 1, body: { note: 'Synthetic: analyzer queue cleared' }, ...o });
  const seed = (o: Partial<ReturnType<typeof item>> = {}): TatSeed => ({ items: [item(1, { alert_level: 'warning', ...o })], labels: [{ membership_id: MEM, display: 'Synthetic Tech' }] });
  it('asserts quality.tat_alert.ack FIRST: a read-only principal gets auth.forbidden and nothing is written', async () => {
    const s = setup(seed()); const c = makeTatCtx({ now: T('11:20:00'), roles: readOnlyTat }); expect(code(await rejection(s.service.acknowledgeTatAlert(c.ctx, input())))).toBe('auth.forbidden');
    expect(c.asserted[0]).toMatchObject({ permission: 'quality.tat_alert.ack' }); expect(s.fake.calls).toEqual([]);
  });
  it('acknowledges: ack row (level = current alert_level, note, the actor\'s membership, the item\'s centre, created_by = actor), item acknowledged_level/at/by, version + 1; 200 with the DTO and the new version', async () => {
    const s = setup(seed()); const c = makeTatCtx({ now: T('11:20:00') }); const r = await s.service.acknowledgeTatAlert(c.ctx, input());
    expect(r).toMatchObject({ status: 200, version: 2 }); expect(r.body).toMatchObject({ tat_item_id: TAT(1), version: 2, alert_level: 'warning', acknowledged_level: 'warning', acknowledged_at: T('11:20:00'), acknowledged_by_display: 'Synthetic Tech' });
    expect(Object.keys(r.body).filter((k) => !DTO_KEYS.includes(k))).toEqual([]);
    expect(s.fake.state.acks).toEqual([{ tenant_id: TENANT_A, tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', note: 'Synthetic: analyzer queue cleared', acknowledged_by_membership_id: MEM, created_at: T('11:20:00'), created_by: c.ctx.actor.id }]);
    expect(s.fake.itemOf(1)).toMatchObject({ acknowledged_level: 'warning', acknowledged_at: T('11:20:00'), acknowledged_by: MEM, version: 2 });
  });
  it('the note is optional (body {}), stored as null; a 500-character note is accepted', async () => {
    const a = setup(seed()); await a.service.acknowledgeTatAlert(makeTatCtx({ now: T('11:20:00') }).ctx, input({ body: {} })); expect(a.fake.state.acks[0]!.note).toBeNull();
    const b = setup(seed()); await b.service.acknowledgeTatAlert(makeTatCtx({ now: T('11:20:00') }).ctx, input({ body: { note: 'x'.repeat(500) } })); expect(b.fake.state.acks[0]!.note).toHaveLength(500);
  });
  it('AC-14.6: after an ack at warning, a later breached level is a NEW unacknowledged alert (it can be acknowledged again, appending a second row)', async () => {
    const s = setup({ ...seed(), pending: [pend(1)] }); await s.service.acknowledgeTatAlert(makeTatCtx({ now: T('11:20:00') }).ctx, input({ body: {} }));
    await s.service.sweep(makeTatCtx({ now: T('12:00:00') }).ctx); const c = makeTatCtx({ now: T('12:00:05') });
    expect(codes(await s.service.listTatAlerts(c.ctx, { acknowledged: false }))).toEqual([TAT(1)]); expect(codes(await s.service.listTatAlerts(c.ctx, { acknowledged: true }))).toEqual([]);
    const v = s.fake.itemOf(1)!.version; await s.service.acknowledgeTatAlert(c.ctx, input({ expectedVersion: v, body: {} }));
    expect(s.fake.state.acks.map((a) => a.level)).toEqual(['warning', 'breached']); expect(codes(await s.service.listTatAlerts(c.ctx, { acknowledged: true }))).toEqual([TAT(1)]);
  });
  it('If-Match missing -> 428 common.precondition_required; a stale version -> 409 common.version_conflict; neither writes', async () => {
    const s = setup(seed({ version: 3 })); const c = makeTatCtx({ now: T('11:20:00') });
    expect(code(await rejection(s.service.acknowledgeTatAlert(c.ctx, input({ expectedVersion: undefined }))))).toBe('common.precondition_required');
    expect(code(await rejection(s.service.acknowledgeTatAlert(c.ctx, input({ expectedVersion: 2 }))))).toBe('common.version_conflict'); expect(s.fake.state.acks).toEqual([]); expect(s.fake.itemOf(1)!.version).toBe(3);
  });
  it('two racing acks with the same version: the loser (repo guard returns undefined) gets 409 common.version_conflict and only one ack row exists', async () => {
    const s = setup(seed()); const c = makeTatCtx({ now: T('11:20:00') }); const real = s.fake.repo.getItem; let first = true;
    s.fake.repo.getItem = async (tx, t, id) => { const row = await real(tx, t, id); if (first) { first = false; await s.fake.repo.ack(tx, t, { id, expectedVersion: 1, level: 'warning', note: null, at: T('11:19:59'), membershipId: MEM, actorId: c.ctx.actor.id }); } return row; };
    expect(code(await rejection(s.service.acknowledgeTatAlert(c.ctx, input())))).toBe('common.version_conflict'); expect(s.fake.state.acks).toHaveLength(1);
  });
  it.each([['stopped clock', { state: 'stopped', stopped_at: T('11:00:00'), stop_source: 'verified_event' }], ['cancelled clock', { state: 'cancelled' }], ['not_started clock', { state: 'not_started', started_at: null, alert_level: 'none' }],
    ['running clock at level none', { alert_level: 'none' }], ['orphan_closed clock', { state: 'orphan_closed' }]])('%s -> 409 common.immutable_record, no ack row, no item change', async (_n, o) => {
    const s = setup(seed(o as never)); const e = await rejection(s.service.acknowledgeTatAlert(makeTatCtx({ now: T('11:20:00') }).ctx, input())); expect(code(e)).toBe('common.immutable_record'); expect(s.fake.state.acks).toEqual([]); expect(s.fake.itemOf(1)!.version).toBe(1);
  });
  it('S-02: an unknown id, another tenant\'s id, or an item of an invisible centre -> 404 common.not_found, nothing written', async () => {
    const o = { items: [item(1, { alert_level: 'warning' }), { ...item(2, { alert_level: 'warning' }), tenant_id: TENANT_B }, item(3, { alert_level: 'warning', centre_id: CEN(2) })] } as TatSeed;
    const s = setup(o, { visibleCentres: [CEN(1)] }); const c = makeTatCtx({ now: T('11:20:00') });
    for (const id of [TAT(99), TAT(2), TAT(3)]) expect(code(await rejection(s.service.acknowledgeTatAlert(c.ctx, input({ tatItemId: id })))), id).toBe('common.not_found'); expect(s.fake.state.acks).toEqual([]);
  });
  it.each([['tenant_id', { tenant_id: TENANT_B }], ['status', { status: 'resolved' }], ['level', { level: 'escalated' }], ['acknowledged_by', { acknowledged_by: MEM }], ['version', { version: 9 }], ['created_by', { created_by: MEM }]])('S-03 mass assignment: body field %s -> 400 common.validation_failed with errors[{ path, code: common.unknown_field }], nothing written', async (field, extra) => {
    const s = setup(seed()); const e = await rejection(s.service.acknowledgeTatAlert(makeTatCtx({ now: T('11:20:00') }).ctx, input({ body: { note: 'ok', ...extra } })));
    expect(code(e)).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail ?? [])).toContain('common.unknown_field'); expect(JSON.stringify(e.errors ?? e.detail ?? [])).toContain(`/${field}`); expect(s.fake.state.acks).toEqual([]);
  });
  it.each([['note 501 chars', { note: 'x'.repeat(501) }], ['note number', { note: 7 }], ['note null', { note: null }], ['body array', []], ['body string', 'x'], ['body null', null]])('invalid body (%s) -> 400 common.validation_failed, nothing written', async (_n, body) => {
    const s = setup(seed()); expect(code(await rejection(s.service.acknowledgeTatAlert(makeTatCtx({ now: T('11:20:00') }).ctx, input({ body }))))).toBe('common.validation_failed'); expect(s.fake.state.acks).toEqual([]);
  });
  it('a note is stored verbatim as a value (never interpolated) and never reaches logs', async () => {
    const s = setup(seed()); const c = makeTatCtx({ now: T('11:20:00') }); const note = "x'; DROP TABLE quality.tat_alert_acks;--"; const logs: unknown[] = []; c.ctx.log = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) };
    await s.service.acknowledgeTatAlert(c.ctx, input({ body: { note } })); expect(s.fake.state.acks[0]!.note).toBe(note); expect(JSON.stringify(logs)).not.toContain('DROP TABLE');
  });
  it('a principal without a membership cannot acknowledge (the ack row needs the membership): fails closed, nothing written', async () => {
    const s = setup(seed()); const e = await rejection(s.service.acknowledgeTatAlert(makeTatCtx({ now: T('11:20:00'), membershipId: null }).ctx, input())); expect(e).toBeInstanceOf(Error); expect(s.fake.state.acks).toEqual([]);
  });
});
void FULL; void forbidden; void TENANT_B;
