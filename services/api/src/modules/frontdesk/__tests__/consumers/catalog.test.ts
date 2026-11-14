// FD-T12 catalog.changed.v1 consumer (02-TRD §8.2: invalidate the in-process per-tenant orderable-metadata cache for revisions <= the event's, record the revision; no side effects, no event;
// 03-IC §3.19: entity_type is x-extensible - an unknown value is applied like any other (invalidate everything), never rejected). C4 has no stored catalog state, so the observable contract is:
// the handler resolves for every shape the producer may send, never throws on unknown values/fields, and writes nothing to any frontdesk table or the event log. Harness: ./helpers.ts. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { IC_EXAMPLES, T, TENANT_A, TENANT_B, consume, consumeQuietly, envelope, ownerRows, uid, type CO } from './helpers.js';

vi.setConfig({ testTimeout: T });
const probeOf = (): NonNullable<CO['probe']> => ({ sms: [], writes: [] });
const catalogEnv = (payload: Record<string, unknown>, o: Parameters<typeof envelope>[2] = {}) => envelope('catalog', payload, { seq: Number(payload['catalog_revision'] ?? 1), ...o });
const FRONTDESK_WRITE = /frontdesk\.|core\.event_log|order_flags|booking_links/i;

describe('catalog.changed.v1', () => {
  it('03-IC §3.19 example verbatim: resolves and writes nothing', async () => {
    const probe = probeOf();
    await expect(consume('catalog', catalogEnv({ ...IC_EXAMPLES.catalog }), { probe })).resolves.toBeUndefined();
    expect(probe.writes.filter((s) => FRONTDESK_WRITE.test(s))).toEqual([]);
  });
  it.each(['department', 'price_list', 'doctor', 'credit_party', 'tax_rule', 'catalog_import', 'global_reference', 'brand_new_entity_type_from_the_future'])(
    'entity_type %s (known or unknown x-extensible value) is accepted: no throw, no write', async (entity_type) => {
      const probe = probeOf();
      await expect(consume('catalog', catalogEnv({ ...IC_EXAMPLES.catalog, entity_type, entity_id: uid() }), { probe })).resolves.toBeUndefined();
      expect(probe.writes.filter((s) => FRONTDESK_WRITE.test(s))).toEqual([]);
    });
  it('revisions arrive unordered and repeated (same revision twice, then a lower one): never an error, never a write', async () => {
    const probe = probeOf();
    for (const rev of [420, 420, 418, 421]) await expect(consume('catalog', catalogEnv({ ...IC_EXAMPLES.catalog, catalog_revision: rev }), { probe })).resolves.toBeUndefined();
    expect(probe.writes.filter((s) => FRONTDESK_WRITE.test(s))).toEqual([]);
  });
  it('unknown payload fields are ignored', async () => {
    const probe = probeOf();
    await expect(consume('catalog', catalogEnv({ ...IC_EXAMPLES.catalog, prices: [{ orderable_id: uid(), paisa: 1 }], future_field: { a: 1 } }, { extra: { trace: 'x' } }), { probe })).resolves.toBeUndefined();
    expect(probe.writes.filter((s) => FRONTDESK_WRITE.test(s))).toEqual([]);
  });
  it('an envelope for another tenant than the job context changes nothing for either tenant', async () => {
    const before = [(await ownerRows('frontdesk.orders', 'tenant_id = $1', [TENANT_A])).length, (await ownerRows('frontdesk.orders', 'tenant_id = $1', [TENANT_B])).length];
    const probe = probeOf();
    await consumeQuietly('catalog', catalogEnv({ ...IC_EXAMPLES.catalog }, { tenant: TENANT_B }), { tenant: TENANT_A, probe });
    expect(probe.writes.filter((s) => FRONTDESK_WRITE.test(s))).toEqual([]);
    expect([(await ownerRows('frontdesk.orders', 'tenant_id = $1', [TENANT_A])).length, (await ownerRows('frontdesk.orders', 'tenant_id = $1', [TENANT_B])).length]).toEqual(before);
  });
});
