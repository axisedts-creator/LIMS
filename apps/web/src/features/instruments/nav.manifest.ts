// C7 04-UI-UX §1 (verbatim). Validated against contracts/routes.yaml by core/nav/build-nav.ts.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'instruments',
  entries: [
    { id: 'instruments.agents', label: 'instruments.nav.agents', routeId: 'staff.instruments.agents', permission: 'instruments.agent.read', group: 'instruments', order: 10, chord: 'g a' },
    { id: 'instruments.instruments', label: 'instruments.nav.instruments', routeId: 'staff.instruments.instruments', permission: 'instruments.instrument.read', group: 'instruments', order: 20, chord: 'g i' },
    { id: 'instruments.messages', label: 'instruments.nav.messages', routeId: 'staff.instruments.messages', permission: 'instruments.message.read', group: 'instruments', order: 30, chord: 'g m' },
    { id: 'instruments.settings', label: 'instruments.nav.settings', routeId: 'staff.instruments.settings', permission: 'instruments.instrument.read', group: 'instruments', order: 90 },
  ],
};
