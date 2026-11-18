// Payments nav manifest (C15 04-UI-UX s1; T0D-NAV-COMPLETE-1, LD-250). ids, routes, permissions, orders are spec-fixed.
// No chord: the spec chord `g y` collides with inventory.home. The intent detail (path parameter) is not a nav entry.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'payments',
  entries: [
    { id: 'payments.review', label: 'payments.nav.review', routeId: 'staff.payments.review', permission: 'payments.reconciliation.read', group: 'billing', order: 60, phase: '1.5', section: 'core.nav.section.payments' },
    { id: 'payments.refunds', label: 'payments.nav.refunds', routeId: 'staff.payments.refunds', permission: 'payments.reconciliation.read', group: 'billing', order: 61, phase: '1.5', section: 'core.nav.section.payments' },
    { id: 'payments.reconciliation', label: 'payments.nav.reconciliation', routeId: 'staff.payments.reconciliation', permission: 'payments.reconciliation.read', group: 'billing', order: 62, phase: '1.5', section: 'core.nav.section.payments' },
    { id: 'payments.static_qr', label: 'payments.nav.static_qr', routeId: 'staff.payments.static_qr', permission: 'payments.reconciliation.read', group: 'billing', order: 63, phase: '1.5', section: 'core.nav.section.payments' },
    { id: 'payments.settings', label: 'payments.nav.settings', routeId: 'staff.payments.settings', permission: 'payments.merchant_config.read', group: 'billing', order: 64, phase: '1.5', section: 'core.nav.section.payments' },
  ],
};

// T0D-UICONSOLE-1 (LD-353 rule 8): menu label keys the review and refunds pages and error boundaries use as their title.
export const pageTitleKey = { review: 'payments.nav.review', refunds: 'payments.nav.refunds' } as const;
