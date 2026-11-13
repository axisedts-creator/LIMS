// Home collection nav manifest (C17 04-UI-UX §1, verbatim). routeId / permission are copied from contracts/routes.yaml (CR-C17-009).
// Chords: `g h` dispatch, `g t` handovers (`g o` is C8's, review #19). C0's build-nav check is authoritative for uniqueness.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'homecollection',
  entries: [
    { id: 'homecollection.dispatch', label: 'homecollection.nav.dispatch', routeId: 'staff.homecollection.dispatch', permission: 'homecollection.visit.read', group: 'home_collection', order: 10, icon: 'table', chord: 'g h', phase: '3' },
    { id: 'homecollection.handovers', label: 'homecollection.nav.handovers', routeId: 'staff.homecollection.handovers', permission: 'homecollection.handover.receive', group: 'home_collection', order: 20, icon: 'inbox', chord: 'g t', phase: '3' },
    { id: 'homecollection.devices', label: 'homecollection.nav.devices', routeId: 'staff.homecollection.devices', permission: 'homecollection.device.manage', group: 'home_collection', order: 30, icon: 'table', phase: '3' },
    { id: 'homecollection.settings', label: 'homecollection.nav.settings', routeId: 'staff.homecollection.settings', permission: 'homecollection.settings.manage', group: 'home_collection', order: 40, icon: 'settings', phase: '3' },
  ],
};
