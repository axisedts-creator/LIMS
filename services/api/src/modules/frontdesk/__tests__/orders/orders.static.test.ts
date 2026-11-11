// FD-T08 static/contract checks (no database). Plan row FD-T08: service/order.service.ts; handlers getOrder (F11) + listOrders (F10); contract frontdesk.yaml.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const F = 'services/api/src/modules/frontdesk';
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const op = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

describe('FD-T08 files and wiring', () => {
  it('service/order.service.ts and the two handlers exist', () => {
    for (const f of ['service/order.service.ts', 'handlers/getOrder.ts', 'handlers/listOrders.ts']) expect(existsSync(join(REPO_ROOT, F, f)), f).toBe(true);
  });
  it('order.service.ts exports getOrder() and listOrders()', async () => {
    const m = await import('../../service/order.service.js');
    expect(m.getOrder).toBeTypeOf('function');
    expect(m.listOrders).toBeTypeOf('function');
  }, 60_000);
  it.each([
    ['getOrder', () => import('../../handlers/getOrder.js')],
    ['listOrders', () => import('../../handlers/listOrders.js')],
  ])('handlers/%s.ts exports `handler` and index.ts wires it as the real operation (LD-70: the writer removes the stub from pending.json)', async (name, load) => {
    const m = await load();
    expect(m.handler).toBeTypeOf('function');
    const idx = await import('../../handlers/index.js');
    expect((idx.handlers as any)[name]).toBe(m.handler);
  });
  it('handlers are thin: delegate to order.service, no repository import', () => {
    for (const n of ['getOrder', 'listOrders']) {
      const src = text(`${F}/handlers/${n}.ts`);
      expect(src, n).toMatch(/order\.service/);
      expect(src, n).not.toMatch(/repository\//);
    }
  });
});

describe('FD-T08 implementation rules (D-5, 03-IC §10.4)', () => {
  const src = () => text(`${F}/service/order.service.ts`);
  it('derives status through LabPort.getOrderItemProcessingState and the pure deriveOrderStatus (no view, no lab table read: 08 R25)', () => {
    expect(src()).toMatch(/getOrderItemProcessingState/);
    expect(src()).toMatch(/deriveOrderStatus/);
    expect(src()).not.toMatch(/\b(FROM|JOIN)\s+lab\./i);                      // C4 reads no other module's tables/views
  });
  it('read paths never write: no INSERT/UPDATE/DELETE (uppercase SQL), no event publish, no stored-status update', () => {
    expect(src()).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(src()).not.toMatch(/events?\.publish/);
  });
  it('time comes from ctx.now(), never Date.now()/new Date() (02-CONVENTIONS clock rule)', () => {
    expect(src()).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
  it('passes no PHI to C5: the lab call input is {orderId} only', () => {
    const m = src().match(/getOrderItemProcessingState\(([^)]*)\)/);
    expect(m, 'getOrderItemProcessingState call').not.toBeNull();
    expect(m![1]).toMatch(/\{\s*orderId[^}]*\}/);
    expect(m![1]).not.toMatch(/patient|name|phone/i);
  });
});

describe('FD-T08 contract', () => {
  it.each([['getOrder', 'get'], ['listOrders', 'get']])('%s is a %s with x-permission frontdesk.order.read and no idempotency', (id) => {
    const o = op(id);
    expect(o['x-permission']).toBe('frontdesk.order.read');
    expect(o['x-idempotency']).toBe('none');
  });
  it('listOrders sort enum is exactly -registered_at / registered_at and declares common.invalid_cursor', () => {
    const o = op('listOrders');
    expect(o.parameters.find((p: any) => p.name === 'sort').schema.enum).toEqual(['-registered_at', 'registered_at']);
    expect(o['x-error-codes']).toContain('common.invalid_cursor');
  });
  it('OrderDto.status admits the derived values and carries a billing block', () => {
    const s = spec.components.schemas.OrderDto;
    expect(s.properties.status.enum).toEqual(['pre_registered', 'registered', 'in_progress', 'completed', 'cancelled']);
    expect(s.properties.billing).toBeDefined();
  });
});
