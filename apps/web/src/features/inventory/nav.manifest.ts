// Inventory nav manifest (04-UI-UX §1 Navigation table; route ids from CR-C12-002; build-nav checks them against contracts/routes.yaml).
// Labels are message keys. Only the home entry has a chord (`g y`).
import type { NavManifest } from '../../core/nav/types';

export const navManifest: NavManifest = {
  module: 'inventory',
  entries: [
    { id: 'inventory.home', label: 'inventory.nav.home', routeId: 'staff.inventory.home', permission: 'inventory.item.read', group: 'inventory', order: 10, chord: 'g y', phase: '2' },
    { id: 'inventory.stock', label: 'inventory.nav.stock', routeId: 'staff.inventory.stock', permission: 'inventory.item.read', group: 'inventory', order: 20, phase: '2' },
    { id: 'inventory.purchase_orders', label: 'inventory.nav.purchase_orders', routeId: 'staff.inventory.purchase_orders', permission: 'inventory.item.read', group: 'inventory', order: 30, phase: '2' },
    { id: 'inventory.receipts', label: 'inventory.nav.receipts', routeId: 'staff.inventory.receipts', permission: 'inventory.item.read', group: 'inventory', order: 40, phase: '2' },
    { id: 'inventory.transfers', label: 'inventory.nav.transfers', routeId: 'staff.inventory.transfers', permission: 'inventory.item.read', group: 'inventory', order: 50, phase: '2' },
    { id: 'inventory.counts', label: 'inventory.nav.counts', routeId: 'staff.inventory.counts', permission: 'inventory.item.read', group: 'inventory', order: 60, phase: '2' },
    { id: 'inventory.bench', label: 'inventory.nav.bench', routeId: 'staff.inventory.bench', permission: 'inventory.bench.record', group: 'inventory', order: 70, phase: '2' },
    { id: 'inventory.items', label: 'inventory.nav.items', routeId: 'staff.inventory.items', permission: 'inventory.item.read', group: 'inventory', order: 80, phase: '2' },
    { id: 'inventory.rules', label: 'inventory.nav.rules', routeId: 'staff.inventory.rules', permission: 'inventory.item.read', group: 'inventory', order: 90, phase: '2' },
    { id: 'inventory.unresolved', label: 'inventory.nav.unresolved', routeId: 'staff.inventory.unresolved', permission: 'inventory.item.read', group: 'inventory', order: 100, phase: '2' },
    { id: 'inventory.alerts', label: 'inventory.nav.alerts', routeId: 'staff.inventory.alerts', permission: 'inventory.item.read', group: 'inventory', order: 110, phase: '2' },
    { id: 'inventory.reports', label: 'inventory.nav.reports', routeId: 'staff.inventory.reports', permission: 'inventory.item.read', group: 'inventory', order: 120, phase: '2' },
    { id: 'inventory.suppliers', label: 'inventory.nav.suppliers', routeId: 'staff.inventory.suppliers', permission: 'inventory.item.read', group: 'inventory', order: 130, phase: '2' },
    { id: 'inventory.stores', label: 'inventory.nav.stores', routeId: 'staff.inventory.stores', permission: 'inventory.item.read', group: 'inventory', order: 140, phase: '2' },
    { id: 'inventory.settings', label: 'inventory.nav.settings', routeId: 'staff.inventory.settings', permission: 'inventory.master.manage', group: 'inventory', order: 150, phase: '2' },
  ],
};
