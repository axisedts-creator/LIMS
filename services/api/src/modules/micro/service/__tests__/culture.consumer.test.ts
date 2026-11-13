// C10 T-06 — consumer lab.specimen.status_changed.v1, NO database (06-IMPLEMENTATION-PLAN row T-06; 02-TRD §8.2 + §11 metrics; PRD AC-01.1, 01.3, 01.4, 01.4a, 01.8 (no parent culture), 01.9;
// 07-SECURITY T-C4/S-19 guard). The state-dependent paths (duplicate, stale seq, re-point, rejection, after-setup) are in culture.consumer.integration.test.ts (live DB).
// Fails now: the consumer file does not exist (the manifest subscription is a fail-closed T-01 stub).
// SEAMS (spec fixes behaviour, not signatures; same convention as C5 T-06 / frontdesk consumers):
//   services/worker/src/jobs/micro/consumers/lab.specimen.status_changed.v1.ts  exports `onSpecimenStatusChanged: ConsumerHandler` (TRD §8.1 name); jobs/micro/index.ts registers it under
//   'lab.specimen.status_changed.v1'. It delegates to service/culture.service.ts `onSpecimenStatusChanged` + repository/cultures.repo.ts (not imported here: only the consumer is the seam).
//   The C0 wrapper (core/consumer.ts) already did inbox dedupe + known-fields-only validation, and opens the tx: the handler gets (envelope, ctx) and opens NO transaction.
//   ctx (JobContext-like): tenantId, actor{type:'system'}, requestId, tx (pg-like .query(text, values) -> {rows}), now(), isNewer(last, seq), log, metrics.inc(name, labels), audit, events,
//   ports {LabPort.getOrderResults, CatalogPort.getTest}. Tenant comes from ctx.tenantId only. Counters are `ctx.metrics.inc(name, labels)` (analytics/billing convention).
//   The handler decides from ports + SQL it issues itself; this file's tx is scripted "empty world": every SELECT returns no rows, every INSERT/UPDATE returns one row {id}.
// Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { manifest } from '../../../../../../worker/src/jobs/micro/index.js';
import { onSpecimenStatusChanged } from '../../../../../../worker/src/jobs/micro/consumers/lab.specimen.status_changed.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const u = (n: number) => `0190c60a-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORDER = u(0x50), PATIENT = u(0x40), CENTRE = u(0x20), ORDER_CENTRE = u(0x21), CULTURE = u(0xc1);
const ITEM_URINE = u(0x61), ITEM_BLOOD = u(0x62), ITEM_CBC = u(0x63);
const TEST_URINE = u(0x71), TEST_BLOOD = u(0x72), TEST_CBC = u(0x73);
const SP_URINE = u(0x91), SP_URINE2 = u(0x92), SP_BLOOD = u(0x93), SP_AL = u(0x94), SP_PARENT = u(0x95), SP_OLD = u(0x96);
const CHANGED_AT = '2026-11-05T03:20:41.300Z';
const TYPE = 'lab.specimen.status_changed.v1';

const TESTS: Record<string, { workflowType: string; specimenTypeCodes: string[] }> = {
  [TEST_URINE]: { workflowType: 'microbiology', specimenTypeCodes: ['urine'] },
  [TEST_BLOOD]: { workflowType: 'microbiology', specimenTypeCodes: ['blood'] },
  [TEST_CBC]: { workflowType: 'standard', specimenTypeCodes: ['blood'] },
};
type Spec = { specimenId: string; specimenTypeCode: string; status: string };
interface World { items?: { orderItemId: string; testId: string }[]; specimens?: Spec[]; labFails?: boolean }
const ITEMS_ALL = [{ orderItemId: ITEM_URINE, testId: TEST_URINE }, { orderItemId: ITEM_BLOOD, testId: TEST_BLOOD }, { orderItemId: ITEM_CBC, testId: TEST_CBC }];

function harness(w: World = {}, tenant: string | undefined = A) {
  const stmts: { text: string; values: unknown[] }[] = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    stmts.push({ text, values });
    return /^\s*(insert|update)/i.test(text) ? { rows: [{ id: CULTURE }], rowCount: 1 } : { rows: [], rowCount: 0 };
  } };
  const lab = { getOrderResults: vi.fn(async (_c: unknown, input: { orderId: string }) => {
    if (w.labFails) throw new Error('lab down');
    return { orderId: input.orderId, specimens: w.specimens ?? [], approvedSetHash: 'h',
      items: (w.items ?? ITEMS_ALL).map((i) => ({ ...i, departmentId: u(0x30), results: [] })) };
  }) };
  const catalog = { getTest: vi.fn(async (_c: unknown, input: { testId: string }) => ({ id: input.testId, code: 'X', name: 'X', isActive: true, revision: 1, analytes: [], ...TESTS[input.testId]! })) };
  const metrics = { inc: vi.fn() };
  const ctx = { tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(0x9), tx, metrics, now: () => '2026-11-05T03:21:00.000Z', isNewer: (l: number | undefined, s: number) => l === undefined || s > l,
    events: { publish: vi.fn() }, audit: { access: vi.fn() }, log: { info() {}, warn() {}, error() {}, child() { return this; } },
    ports: { LabPort: lab, CatalogPort: catalog } };
  const writes = () => stmts.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.text));
  const cultureInserts = () => stmts.filter((s) => /^\s*insert\s+into\s+micro\.cultures\b/i.test(s.text));
  const transitionInserts = () => stmts.filter((s) => /^\s*insert\s+into\s+micro\.culture_transitions\b/i.test(s.text));
  const cultureUpdates = () => stmts.filter((s) => /^\s*update\s+micro\.cultures\b/i.test(s.text));
  return { ctx, stmts, lab, catalog, metrics, writes, cultureInserts, transitionInserts, cultureUpdates };
}

const payload = (o: Record<string, unknown> = {}) => ({ specimen_id: SP_URINE, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, specimen_type_code: 'urine',
  to_status: 'received', changed_at: CHANGED_AT, order_item_ids: [ITEM_URINE], ...o });
const envelope = (p: Record<string, unknown>, o: { seq?: number; tenant?: string; eventId?: string } = {}) => ({ event_id: o.eventId ?? u(0xe1), event_type: TYPE, tenant_id: o.tenant ?? A,
  occurred_at: CHANGED_AT, actor: { type: 'system', id: u(0xa1) }, idempotency_key: `${p['specimen_id']}:${p['to_status']}:${o.seq ?? 1}`, producer: 'lab',
  aggregate: { type: 'specimen', id: p['specimen_id'], seq: o.seq ?? 1 }, request_id: u(0xb1), payload: p });
const run = (h: ReturnType<typeof harness>, env: unknown) => (onSpecimenStatusChanged as (e: unknown, c: unknown) => Promise<void>)(env, h.ctx);

const same = (v: unknown, x: unknown) => v === x || (v instanceof Date && typeof x === 'string' && v.getTime() === Date.parse(x))
  || (typeof v === 'string' && typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) && Date.parse(v) === Date.parse(x));
const hasValue = (s: { text: string; values: unknown[] }, x: unknown) => s.values.some((v) => same(v, x)) || (typeof x === 'string' && s.text.includes(`'${x}'`));
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } return undefined; };

describe('T-06 wiring', () => {
  it('manifest.subscriptions[lab.specimen.status_changed.v1] is the real handler, not the T-01 fail-closed stub', () => {
    expect(typeof onSpecimenStatusChanged).toBe('function');
    expect(manifest.subscriptions?.[TYPE]).toBe(onSpecimenStatusChanged);
  });
  it('instruments.result.received.v1 stays registered (T-xx later task) — T-06 must not drop it', () => {
    expect(typeof manifest.subscriptions?.['instruments.result.received.v1']).toBe('function');
  });
});

describe('AC-01.1 received -> culture (scripted empty world)', () => {
  it('micro item in order_item_ids: ONE cultures insert with status awaiting_setup, received_at = changed_at, ids/centre/type from the event + ports, last_specimen_seq = aggregate.seq', async () => {
    const h = harness();
    await run(h, envelope(payload(), { seq: 7 }));
    expect(h.cultureInserts()).toHaveLength(1);
    const ins = h.cultureInserts()[0]!;
    for (const x of [ITEM_URINE, SP_URINE, ORDER, PATIENT, CENTRE, TEST_URINE, 'urine', 'awaiting_setup', CHANGED_AT, 7, A]) expect(hasValue(ins, x), `insert must carry ${String(x)}`).toBe(true);
  });
  it('centre_id of the culture is the EVENT centre (collection centre), never the order centre; the culture_transitions child copies it (∅ -> awaiting_setup)', async () => {
    const h = harness();
    await run(h, envelope(payload()));
    expect(h.cultureInserts()[0]!.values).not.toContain(ORDER_CENTRE);
    const t = h.transitionInserts();
    expect(t).toHaveLength(1);
    expect(hasValue(t[0]!, CENTRE)).toBe(true);
    expect(hasValue(t[0]!, 'awaiting_setup')).toBe(true);
    expect(t[0]!.values.filter((v) => v === 'awaiting_setup' || v === null).length).toBeGreaterThan(0);   // from_status ∅ (NULL) -> awaiting_setup
  });
  it('tenant comes from ctx.tenantId only (RLS claims), the insert carries it', async () => {
    const h = harness();
    await run(h, envelope(payload()));
    expect(hasValue(h.cultureInserts()[0]!, A)).toBe(true);
    expect(hasValue(h.cultureInserts()[0]!, B)).toBe(false);
  });
  it('IC §3.7 example payload (EDTA_WB, from_status in_transit, processing_branch_id) is accepted verbatim; no barcode/branch is required; specimen_type_code is stored as given', async () => {
    const h = harness({ items: [{ orderItemId: u(0x6001), testId: TEST_URINE }] });
    const p = { specimen_id: '01a1a98a-ac40-7000-8000-000000090001', order_id: '01a1a98a-ac40-7000-8000-000000050001', patient_id: '01a1a98a-ac40-7000-8000-000000040001',
      centre_id: '01a1a98a-ac40-7000-8000-000000020002', processing_branch_id: '01a1a98a-ac40-7000-8000-000000010001', specimen_type_code: 'EDTA_WB', from_status: 'in_transit',
      to_status: 'received', changed_at: CHANGED_AT, order_item_ids: [u(0x6001)] };
    await run(h, envelope(p));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(hasValue(h.cultureInserts()[0]!, 'EDTA_WB')).toBe(true);
    expect(hasValue(h.cultureInserts()[0]!, '01a1a98a-ac40-7000-8000-000000010001'), 'no processing-centre snapshot (08 A17 D-63)').toBe(false);
  });
  it('extra payload fields (future additive fields, PHI-looking noise) are tolerated and never persisted', async () => {
    const h = harness();
    await run(h, envelope(payload({ barcode: 'SENTINEL-BARCODE-X1', patient_name: 'SENTINEL-PHI-Sita-Karki', future_field: { a: 1 } })));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(JSON.stringify(h.stmts)).not.toMatch(/SENTINEL/);
  });
  it('order_item_ids with a micro and a non-micro item: only the micro item gets a culture', async () => {
    const h = harness();
    await run(h, envelope(payload({ order_item_ids: [ITEM_CBC, ITEM_URINE] })));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(hasValue(h.cultureInserts()[0]!, ITEM_URINE)).toBe(true);
    expect(hasValue(h.cultureInserts()[0]!, ITEM_CBC)).toBe(false);
  });
});

describe('AC-01.4 no microbiology item -> no culture', () => {
  it('order_item_ids = only a standard-workflow item: nothing written to micro.* and the handler resolves', async () => {
    const h = harness();
    await expect(run(h, envelope(payload({ order_item_ids: [ITEM_CBC], specimen_type_code: 'blood' })))).resolves.toBeUndefined();
    expect(h.writes().filter((s) => /micro\./i.test(s.text))).toEqual([]);
    expect(h.metrics.inc).not.toHaveBeenCalled();
  });
});

describe('AC-01.4a order_item_ids absent -> specimen-type filter; ambiguity -> no culture + metric', () => {
  it('urine C/S + blood culture on two specimens: the urine specimen creates a culture ONLY for the urine item', async () => {
    const h = harness({ items: [{ orderItemId: ITEM_URINE, testId: TEST_URINE }, { orderItemId: ITEM_BLOOD, testId: TEST_BLOOD }],
      specimens: [{ specimenId: SP_URINE, specimenTypeCode: 'urine', status: 'received' }, { specimenId: SP_BLOOD, specimenTypeCode: 'blood', status: 'received' }] });
    await run(h, envelope(payload({ order_item_ids: undefined })));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(hasValue(h.cultureInserts()[0]!, ITEM_URINE)).toBe(true);
    expect(hasValue(h.cultureInserts()[0]!, ITEM_BLOOD)).toBe(false);
    expect(h.metrics.inc).not.toHaveBeenCalledWith('lims_micro_unmapped_received_total', expect.anything());
  });
  it('the blood specimen of the same order creates the culture for the blood item only', async () => {
    const h = harness({ items: [{ orderItemId: ITEM_URINE, testId: TEST_URINE }, { orderItemId: ITEM_BLOOD, testId: TEST_BLOOD }],
      specimens: [{ specimenId: SP_URINE, specimenTypeCode: 'urine', status: 'received' }, { specimenId: SP_BLOOD, specimenTypeCode: 'blood', status: 'received' }] });
    await run(h, envelope(payload({ order_item_ids: undefined, specimen_id: SP_BLOOD, specimen_type_code: 'blood' })));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(hasValue(h.cultureInserts()[0]!, ITEM_BLOOD)).toBe(true);
    expect(hasValue(h.cultureInserts()[0]!, SP_BLOOD)).toBe(true);
  });
  it('two non-rejected specimens of the event specimen type: NO culture, lims_micro_unmapped_received_total +1 (tenant_id label), handler resolves (finish, no retry)', async () => {
    const h = harness({ items: [{ orderItemId: ITEM_URINE, testId: TEST_URINE }],
      specimens: [{ specimenId: SP_URINE, specimenTypeCode: 'urine', status: 'received' }, { specimenId: SP_URINE2, specimenTypeCode: 'urine', status: 'received' }] });
    await expect(run(h, envelope(payload({ order_item_ids: undefined })))).resolves.toBeUndefined();
    expect(h.writes().filter((s) => /micro\./i.test(s.text))).toEqual([]);
    expect(h.metrics.inc).toHaveBeenCalledTimes(1);
    expect(h.metrics.inc.mock.calls[0]![0]).toBe('lims_micro_unmapped_received_total');
    expect(h.metrics.inc.mock.calls[0]![1]).toMatchObject({ tenant_id: A });
  });
  it('a REJECTED second specimen of the same type does not make it ambiguous (only non-rejected specimens count) -> culture created, no metric', async () => {
    const h = harness({ items: [{ orderItemId: ITEM_URINE, testId: TEST_URINE }],
      specimens: [{ specimenId: SP_URINE, specimenTypeCode: 'urine', status: 'received' }, { specimenId: SP_URINE2, specimenTypeCode: 'urine', status: 'rejected' }] });
    await run(h, envelope(payload({ order_item_ids: undefined })));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(h.metrics.inc).not.toHaveBeenCalledWith('lims_micro_unmapped_received_total', expect.anything());
  });
  it('no micro item of the order matches the event specimen type: no culture, no metric (not an ambiguity)', async () => {
    const h = harness({ items: [{ orderItemId: ITEM_BLOOD, testId: TEST_BLOOD }], specimens: [{ specimenId: SP_URINE, specimenTypeCode: 'urine', status: 'received' }] });
    await run(h, envelope(payload({ order_item_ids: undefined })));
    expect(h.writes().filter((s) => /micro\./i.test(s.text))).toEqual([]);
    expect(h.metrics.inc).not.toHaveBeenCalledWith('lims_micro_unmapped_received_total', expect.anything());
  });
});

describe('AC-01.8 aliquot with NO culture for (I, parent) = a normal received specimen (TRD §8.2)', () => {
  it('aliquot event (from_status absent, parent_specimen_id set), no culture for (I, P): a culture is created for (I, aliquot), no re-point, no aliquot-after-setup metric', async () => {
    const h = harness();
    await run(h, envelope(payload({ specimen_id: SP_AL, parent_specimen_id: SP_PARENT }), { seq: 1 }));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(hasValue(h.cultureInserts()[0]!, SP_AL)).toBe(true);
    expect(h.cultureUpdates()).toEqual([]);
    expect(h.metrics.inc).not.toHaveBeenCalledWith('lims_micro_aliquot_after_setup_total');
  });
});

describe('AC-01.9 recollection specimen received (replaces_specimen_id set) -> new culture for (I, new specimen)', () => {
  it('creates the culture for the NEW specimen; the old specimen id is not written and no existing culture is updated by this event', async () => {
    const h = harness();
    await run(h, envelope(payload({ specimen_id: SP_AL, replaces_specimen_id: SP_OLD })));
    expect(h.cultureInserts()).toHaveLength(1);
    expect(hasValue(h.cultureInserts()[0]!, SP_AL)).toBe(true);
    expect(hasValue(h.cultureInserts()[0]!, SP_OLD)).toBe(false);
    expect(h.cultureUpdates()).toEqual([]);
  });
});

describe('statuses that need no culture', () => {
  for (const to of ['collected', 'in_transit', 'resulted', 'approved', 'reported', 'discarded']) {
    it(`to_status=${to} with no culture: nothing created (inbox only / last_specimen_seq update of an existing culture)`, async () => {
      const h = harness();
      await expect(run(h, envelope(payload({ to_status: to, from_status: 'received' })))).resolves.toBeUndefined();
      expect(h.cultureInserts()).toEqual([]);
    });
  }
  it('to_status=rejected with no culture: nothing created, nothing cancelled, no after-report metric', async () => {
    const h = harness();
    await expect(run(h, envelope(payload({ to_status: 'rejected', from_status: 'received' })))).resolves.toBeUndefined();
    expect(h.cultureInserts()).toEqual([]);
    expect(h.metrics.inc).not.toHaveBeenCalledWith('lims_micro_specimen_rejected_after_report_total');
  });
  it('an unknown future to_status (x-extensible enum) is inbox-only: resolves, writes no culture', async () => {
    const h = harness();
    await expect(run(h, envelope(payload({ to_status: 'quarantined_v2' })))).resolves.toBeUndefined();
    expect(h.cultureInserts()).toEqual([]);
  });
});

describe('failure and tenant guards (07 T-C4/S-19; dependency failure)', () => {
  it('LabPort failure: the handler REJECTS (the job retries then dead-letters, never a silent ack) and writes nothing', async () => {
    const h = harness({ labFails: true });
    expect(await failure(run(h, envelope(payload())))).toBeDefined();
    expect(h.writes().filter((s) => /micro\./i.test(s.text))).toEqual([]);
  });
  it('envelope of tenant B on a tenant-A job: no write, no port call, no metric (rejecting or resolving are both acceptable)', async () => {
    const h = harness();
    await failure(run(h, envelope(payload(), { tenant: B })));
    expect(h.writes()).toEqual([]);
    expect(h.lab.getOrderResults).not.toHaveBeenCalled();
    expect(h.catalog.getTest).not.toHaveBeenCalled();
    expect(h.metrics.inc).not.toHaveBeenCalled();
  });
  it('the handler publishes no event and opens no transaction of its own (C10 produces nothing, TRD §8.1)', async () => {
    const h = harness();
    await run(h, envelope(payload()));
    expect(h.ctx.events.publish).not.toHaveBeenCalled();
    expect(h.stmts.some((s) => /^\s*(begin|commit|rollback|savepoint)\b/i.test(s.text))).toBe(false);
  });
});
