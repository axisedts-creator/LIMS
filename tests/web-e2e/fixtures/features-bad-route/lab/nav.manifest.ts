import type { NavManifest } from '@/core/nav/types';
export const navManifest: NavManifest = {
  module: 'lab',
  entries: [
    { id: 'lab.nope', label: 'lab.nav.nope', routeId: 'staff.lab.does_not_exist', permission: 'lab.status_board.read', group: 'laboratory', order: 10, chord: 'g s' },
  ],
};
