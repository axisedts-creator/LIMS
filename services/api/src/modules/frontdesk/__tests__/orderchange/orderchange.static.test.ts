// FD-T09 static/contract checks (no database). Plan row FD-T09: service/order.service.ts; handlers quoteOrderItemsChange (F8b), changeOrderItems (F13), cancelOrder (F14); contract frontdesk.yaml.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const F = 'services/api/src/modules/frontdesk';
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const op = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const NAMES = ['quoteOrderItemsChange', 'changeOrderItems', 'cancelOrder'] as const;

describe('FD-T09 files and wiring', () => {
  it('the three handlers exist', () => {
    for (const n of NAMES) expect(existsSync(join(REPO_ROOT, F, `handlers/${n}.ts`)), n).toBe(true);
  });
  it.each([
    ['quoteOrderItemsChange', () => import('../../handlers/quoteOrderItemsChange.js')],
    ['changeOrderItems', () => import('../../handlers/changeOrderItems.js')],
    ['cancelOrder', () => import('../../handlers/cancelOrder.js')],
  ])('handlers/%s.ts exports `handler` and index.ts wires it as the real operation (LD-70: the writer removes the stub from pending.json)', async (name, load) => {
    const m = await load();
    expect(m.handler).toBeTypeOf('function');
    const idx = await import('../../handlers/index.js');
    expect((idx.handlers as any)[name]).toBe(m.handler);
  }, 60_000);
  it('handlers are thin: delegate to order.service, no repository import', () => {
    for (const n of NAMES) {
      const src = text(`${F}/handlers/${n}.ts`);
      expect(src, n).toMatch(/order\.service/);
      expect(src, n).not.toMatch(/repository\//);
    }
  });
});

describe('FD-T09 implementation rules', () => {
  const svc = () => text(`${F}/service/order.service.ts`);
  const withEvents = () => svc() + (existsSync(join(REPO_ROOT, F, 'events/publish.ts')) ? text(`${F}/events/publish.ts`) : '');
  it('publishes frontdesk.order.items_changed.v1 and frontdesk.order.cancelled.v1 (02-TRD §8.1)', () => {
    expect(withEvents()).toMatch(/frontdesk\.order\.items_changed\.v1/);
    expect(withEvents()).toMatch(/frontdesk\.order\.cancelled\.v1/);
  });
  it('uses the ports named by 02-TRD §6.4: LabPort removal guard + approved-results cancel guard, BillingCommandPort calls', () => {
    for (const m of ['getOrderItemProcessingState', 'getOrderResults', 'issueOrderInvoice', 'recordCreditCharges', 'voidCreditCharges', 'raiseCreditNoteRequirement']) expect(svc(), m).toContain(m);
    expect(svc()).toMatch(/supplementary/);
    expect(svc()).toMatch(/item_removed/);
    expect(svc()).toMatch(/order_cancelled/);
  });
  it('reads no other module\'s tables/views (08 R25) and takes time from ctx.now(), never Date.now()/new Date()', () => {
    expect(svc()).not.toMatch(/\b(FROM|JOIN)\s+(lab|billing)\./i);
    expect(svc()).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
  it('the lab calls carry no PHI: input is {orderId[, scope]} only', () => {
    for (const m of svc().matchAll(/(?:getOrderItemProcessingState|getOrderResults)\(([^)]*)\)/g)) expect(m[1]).not.toMatch(/patient|name|phone/i);
  });
});

describe('FD-T09 contract', () => {
  it.each([['quoteOrderItemsChange', 'frontdesk.order.edit', 'none'], ['changeOrderItems', 'frontdesk.order.edit', 'required'], ['cancelOrder', 'frontdesk.order.cancel', 'required']])(
    '%s: x-permission %s, x-idempotency %s', (id, perm, idem) => {
      expect(op(id)['x-permission']).toBe(perm);
      expect(op(id)['x-idempotency']).toBe(idem);
    });
  it('error codes: F8b/F13 order_not_editable + order_already_cancelled; F13 version_conflict + counter_busy; F14 cancel_not_allowed + already_cancelled', () => {
    for (const c of ['frontdesk.order_not_editable', 'frontdesk.order_already_cancelled', 'catalog.test_inactive', 'catalog.no_price', 'catalog.tax_config_missing']) expect(op('quoteOrderItemsChange')['x-error-codes'], c).toContain(c);
    for (const c of ['frontdesk.order_not_editable', 'frontdesk.order_already_cancelled', 'common.version_conflict', 'billing.counter_busy', 'common.precondition_required']) expect(op('changeOrderItems')['x-error-codes'], c).toContain(c);
    for (const c of ['frontdesk.order_cancel_not_allowed', 'frontdesk.order_already_cancelled', 'common.version_conflict', 'common.precondition_required']) expect(op('cancelOrder')['x-error-codes'], c).toContain(c);
  });
  it('ChangeOrderItemsResult carries supplementary_invoice and credit_note_required; request limits 50/50/5', () => {
    const r = spec.components.schemas.ChangeOrderItemsResult.properties;
    expect(r.supplementary_invoice).toBeDefined();
    expect(r.credit_note_required).toBeDefined();
    const q = spec.components.schemas.ChangeOrderItemsRequest.properties;
    expect([q.add.maxItems, q.remove.maxItems, q.payments.maxItems]).toEqual([50, 50, 5]);
    expect(spec.components.schemas.CancelOrderRequest.properties.reason_text.maxLength).toBe(500);
  });
});
