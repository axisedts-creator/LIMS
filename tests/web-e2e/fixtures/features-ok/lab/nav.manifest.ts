import type { NavManifest } from '@/core/nav/types';
export const navManifest: NavManifest = {
  module: 'lab',
  entries: [
    { id: 'lab.status_board', label: 'lab.nav.status_board', routeId: 'staff.lab.status_board', permission: 'lab.status_board.read', group: 'laboratory', order: 10, chord: 'g s' },
  ],
};
