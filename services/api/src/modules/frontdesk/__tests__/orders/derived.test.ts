// FD-T08 derived order status (03-IC §10.4 as amended by 08 A13 D-5 + A17.2; 02-TRD §5.1 F11 / §6 getOrderSummary; 03-APP-FLOW O4/O5).
// Integration: handler over real PG17 + the REAL LabPort fake. The fake derives each item's processingStatus from lab facts (specimens, results), so
// the "rejected without recollection -> cancelled" case is exercised end to end, not stubbed.
//   in_progress  iff any active item is in_progress/reported
//   completed    iff every active item is reported or cancelled AND >= 1 is reported
//   otherwise    the stored status; pre_registered / cancelled are returned stored WITHOUT a LabPort call; nothing is written (O4/O5 "none stored").
import { describe, expect, it } from 'vitest';
import { T, TENANT_A, TENANT_B, getFails, getOrder, listOrders, mergeInto, orderRow, scenario, sharedFakes, type ItemSpec, type LabState } from './helpers.js';

const WINDOW = { registered_at_from: '2043-01-01T00:00:00.000Z', registered_at_to: '2043-12-31T00:00:00.000Z' };
const at = (day: number) => `2043-06-${String(day).padStart(2, '0')}T04:00:00.000Z`;

type Row = [stored: string, items: (LabState | ItemSpec)[], expected: string, why: string];
const MATRIX: Row[] = [
  ['registered', ['not_started'], 'registered', 'nothing started'],
  ['registered', ['in_progress'], 'in_progress', 'specimen received'],
  ['registered', ['result_entered_only'], 'in_progress', 'A17.2: existing-material item with a result beyond pending'],
  ['registered', ['reported'], 'completed', 'single item reported'],
  ['registered', ['reported', 'not_started'], 'in_progress', 'one reported, one not started'],
  ['registered', ['reported', 'in_progress'], 'in_progress', 'one reported, one in progress'],
  ['registered', ['reported', 'cancelled'], 'completed', 'reported + cancelled item'],
  ['registered', ['reported', 'reported'], 'completed', 'all reported'],
  ['registered', ['cancelled'], 'registered', 'no reported item: not completed'],
  ['registered', ['not_started', 'cancelled'], 'registered', 'cancelled item does not start the order'],
  ['registered', ['in_progress', 'cancelled'], 'in_progress', 'cancelled item ignored'],
  // 08 A13 D-5: an item whose only specimen was rejected without recollection is `cancelled`.
  ['registered', ['rejected_no_recollection'], 'registered', 'D-5: only item cancelled, none reported -> stays registered'],
  ['registered', ['reported', 'rejected_no_recollection'], 'completed', 'D-5: rejected-without-recollection item -> cancelled -> order completed'],
  ['registered', ['reported', 'reported', 'rejected_no_recollection'], 'completed', 'D-5 with several reported items'],
  ['registered', ['in_progress', 'rejected_no_recollection'], 'in_progress', 'D-5: rejected item cancelled, other still running'],
  ['registered', ['not_started', 'rejected_no_recollection'], 'registered', 'D-5: rejected item cancelled, other not started'],
  ['registered', ['rejected_recollection_pending'], 'registered', 'recollection pending: item is not cancelled, not started'],
  ['registered', ['reported', 'rejected_recollection_pending'], 'in_progress', 'recollection pending blocks completed'],
  ['registered', ['rejected_recollection_received'], 'in_progress', 'recollected specimen received'],
  ['in_progress', ['reported', 'cancelled'], 'completed', 'stored in_progress also derives completed'],
  ['in_progress', ['reported', 'rejected_no_recollection'], 'completed', 'D-5 from stored in_progress'],
  ['in_progress', ['in_progress'], 'in_progress', 'stored in_progress stays in_progress'],
  // only ACTIVE items count ("every active item")
  ['registered', ['reported', { lab: 'in_progress', status: 'removed' }], 'completed', 'removed item is ignored (would otherwise block completed)'],
  ['registered', ['not_started', { lab: 'reported', status: 'removed' }], 'registered', 'removed reported item must not start the order'],
];

describe('derived status via F11 getOrder (D-5)', () => {
  it.each(MATRIX)('%s + %j -> %s (%s)', { timeout: T }, async (stored, items, expected) => {
    const s = await scenario({ stored, items });
    const r = await getOrder(s.order.id, { s });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe(expected);
  });

  // review item 1: derivation runs over ACTIVE C4 items; an active item with no lab row counts as not_started.
  it.each([
    [['reported', { lab: 'not_started', labOmit: true }], 'in_progress', 'one reported, active item missing from lab (not_started) -> in_progress'],
    [[{ lab: 'reported', labOmit: true }, 'reported'], 'in_progress', 'sanity: omitted item is not_started, never skipped'],
  ] as [(LabState | ItemSpec)[], string, string][])('active item absent from LabPort is treated as not_started: %j -> %s (%s)', { timeout: T }, async (items, expected) => {
    const s = await scenario({ items });
    expect((await getOrder(s.order.id, { s })).body.status).toBe(expected);
  });
  it('two active items both absent from LabPort -> stays registered',{ timeout: T }, async () => {
    const s = await scenario({ items: [{ lab: 'not_started', labOmit: true }, { lab: 'not_started', labOmit: true }] });
    expect((await getOrder(s.order.id, { s })).body.status).toBe('registered');
  });

  it('calls LabPort.getOrderItemProcessingState exactly once, with only {orderId}, in the caller tenant (no PHI to C5)', { timeout: T }, async () => {
    const s = await scenario({ items: ['reported', 'in_progress'] });
    await getOrder(s.order.id, { s });
    const calls = s.labPortCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ orderId: s.order.id });
    expect(calls[0]!.ctx.tenantId).toBe(TENANT_A);
  });

  it.each(['pre_registered', 'cancelled'])('%s is returned stored, without any LabPort call, even if the lab fake reports items', { timeout: T }, async (stored) => {
    const s = await scenario({ stored, items: ['reported', 'in_progress'] });
    const r = await getOrder(s.order.id, { s });
    expect(r.body.status).toBe(stored);
    expect(s.labPortCalls()).toHaveLength(0);
  });
  it('stored completed is never downgraded by lab state', { timeout: T }, async () => {
    const s = await scenario({ stored: 'completed', items: ['in_progress'] });
    expect((await getOrder(s.order.id, { s })).body.status).toBe('completed');
  });

  it('derivation writes nothing: stored status and version are unchanged and the request tx performed no write (O4/O5 "none stored")', { timeout: T }, async () => {
    const s = await scenario({ items: ['reported'] });
    const before = await orderRow(s.order.id);
    const r = await getOrder(s.order.id, { s });
    expect(r.body.status).toBe('completed');
    expect(r.wrote).toBe(false);
    const after = await orderRow(s.order.id);
    expect(after.status).toBe('registered');
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it('status is re-derived on every read: when the lab receives the specimen the next read follows (nothing cached in the row)', { timeout: T }, async () => {
    const s = await scenario({ items: ['not_started'] });
    expect((await getOrder(s.order.id, { s })).body.status).toBe('registered');
    s.lab.__seed({ specimens: [{ id: s.items[0].id.replace(/.$/, 'f'), tenantId: TENANT_A, orderId: s.order.id, barcode: `FDT08-${s.items[0].id.slice(-12)}`, specimenTypeCode: 'BLOOD',
      status: 'received', itemIds: [s.items[0].id], receivedAt: '2026-11-07T01:00:00.000Z', isActive: true, version: 1 }] });
    expect((await getOrder(s.order.id, { s })).body.status).toBe('in_progress');
    expect(s.labPortCalls()).toHaveLength(2);
  });

  it('cross-tenant: tenant B asking for tenant A order -> 404 common.not_found, and no LabPort call is made for it', { timeout: T }, async () => {
    const s = await scenario({ items: ['reported'] });
    const e = await getFails(s.order.id, { tenant: TENANT_B, s });
    expect(e.code).toBe('common.not_found');
    expect(s.labPortCalls()).toHaveLength(0);
  });
});

describe('derived status via F10 listOrders (same rule per row)', () => {
  it('each row carries the derived status; LabPort is called once per registered/in_progress order only', { timeout: T }, async () => {
    const shared = sharedFakes();
    const defs: [string, (LabState | ItemSpec)[], string][] = [
      ['registered', ['reported', 'rejected_no_recollection'], 'completed'],
      ['registered', ['in_progress'], 'in_progress'],
      ['registered', ['not_started'], 'registered'],
      ['in_progress', ['reported', 'cancelled'], 'completed'],
      ['pre_registered', ['reported'], 'pre_registered'],
      ['cancelled', ['reported'], 'cancelled'],
    ];
    const made = [];
    for (const [i, [stored, items]] of defs.entries()) {
      const s = await scenario({ stored, items, order: { registered_at: at(i + 1) } });
      mergeInto(shared, s);
      made.push(s);
    }
    const r = await listOrders({ ...WINDOW, limit: 50 }, { lab: shared.lab, billing: shared.billing });
    expect(r.status).toBe(200);
    for (const [i, s] of made.entries()) {
      const row = r.body.data.find((x: any) => x.id === s.order.id);
      expect(row, `order #${i}`).toBeDefined();
      expect(row.status).toBe(defs[i]![2]);
    }
    const asked = shared.lab.calls('getOrderItemProcessingState').map((c: any) => c.input.orderId);
    const derivable = made.filter((_, i) => ['registered', 'in_progress'].includes(defs[i]![0])).map((s) => s.order.id).sort();
    expect([...asked].sort()).toEqual(derivable);
  });
});
