// C10 04-UI-UX §1 (verbatim). Validated against contracts/routes.yaml by core/nav/build-nav.ts. Culture detail is not a nav entry.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'micro',
  entries: [
    { id: 'micro.worklist', label: 'micro.nav.worklist', routeId: 'staff.micro.worklist', permission: 'micro.culture.read', group: 'laboratory', order: 60, icon: 'flask', chord: 'g u', phase: '2' },
    { id: 'micro.instrument_records', label: 'micro.nav.instrument_records', routeId: 'staff.micro.instrument_records', permission: 'micro.culture.read', group: 'laboratory', order: 61, icon: 'inbox', phase: '2' },
    { id: 'micro.settings', label: 'micro.nav.settings', routeId: 'staff.micro.settings', permission: 'micro.config.manage', group: 'laboratory', order: 62, icon: 'settings', phase: '2' },
    { id: 'micro.breakpoint_sets', label: 'micro.nav.breakpoint_sets', routeId: 'staff.micro.breakpoint_sets', permission: 'micro.breakpoint.manage', group: 'laboratory', order: 63, icon: 'table', phase: '2' },
  ],
};
