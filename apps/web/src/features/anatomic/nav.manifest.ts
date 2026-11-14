// C11 04-UI-UX §1 (verbatim). Validated against contracts/routes.yaml by core/nav/build-nav.ts. Case detail is not a nav entry.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'anatomic',
  entries: [
    { id: 'anatomic.worklist', label: 'anatomic.nav.worklist', routeId: 'staff.anatomic.worklist', permission: 'anatomic.case.read', group: 'laboratory', order: 60, icon: 'flask', chord: 'g p', phase: '2' },
    { id: 'anatomic.tracking', label: 'anatomic.nav.tracking', routeId: 'staff.anatomic.tracking', permission: 'anatomic.case.read', group: 'laboratory', order: 61, icon: 'inbox', phase: '2' },
    { id: 'anatomic.batches', label: 'anatomic.nav.batches', routeId: 'staff.anatomic.batches', permission: 'anatomic.case.read', group: 'laboratory', order: 62, icon: 'table', phase: '2' },
    { id: 'anatomic.config', label: 'anatomic.nav.config', routeId: 'staff.anatomic.config', permission: 'anatomic.config.manage', group: 'laboratory', order: 63, icon: 'settings', phase: '2' },
  ],
};
