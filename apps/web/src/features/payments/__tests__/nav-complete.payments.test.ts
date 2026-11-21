// T0D-NAV-COMPLETE-1 (LD-250): payments manifest = C15 04-UI-UX s1 (5 entries, group billing, orders 60-64, phase 1.5; ids, routeIds,
// permissions are spec-fixed). The spec chord `g y` collides with inventory.home: the build check rejects duplicates, so the writer
// picks another (or none); chords are not compared here, only unique via nav-complete.build.test.ts.
import { describe, expect, it } from 'vitest';
import { loadManifest, specSuite } from '../../../core/nav/__tests__/nav-complete.helpers.ts';

const row = (id: string, name: string, path: string, permission: string, order: number) =>
  ({ name, path, permission, group: 'billing', order, phase: '1.5', id: `payments.${id}`, routeId: `staff.payments.${id}` }) as const;

specSuite({
  module: 'payments',
  owner: 'C15',
  section: 'C15 04-UI-UX s1',
  rows: [
    row('review', 'Payment review', '/payments/review', 'payments.reconciliation.read', 60),
    row('refunds', 'Gateway refunds', '/payments/refunds', 'payments.reconciliation.read', 61),
    row('reconciliation', 'Gateway reconciliation', '/payments/reconciliation', 'payments.reconciliation.read', 62),
    row('static_qr', 'Fonepay QR worksheet', '/payments/static-qr', 'payments.reconciliation.read', 63),
    row('settings', 'Payment gateways', '/payments/settings', 'payments.merchant_config.read', 64),
  ],
});

describe('payments nav labels (C15 s1 label keys)', () => {
  it('label keys are payments.nav.<id suffix>', async () => {
    const m = await loadManifest('payments');
    for (const e of m.entries) expect(e.label).toBe(`payments.nav.${e.id.slice('payments.'.length)}`);
  });
  it('the payment-intent detail (path parameter) is not a nav entry', async () => {
    const m = await loadManifest('payments');
    expect(m.entries.some((e) => e.routeId === 'staff.payments.intent')).toBe(false);
  });
});
