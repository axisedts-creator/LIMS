// Lab nav manifest (C5 04-UI-UX s1; T0D-NAV-COMPLETE-1, LD-250). Paths/permissions from the spec table; order = table order [CONV].
// Worklists (/lab/worklists) and Critical values (/lab/critical-values) have no page yet -> no entry, see CR T0D-NAV-COMPLETE-1.1.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'lab',
  entries: [
    { id: 'lab.status_board', label: 'lab.nav.status_board', routeId: 'staff.lab.status_board', permission: 'lab.status_board.read', group: 'laboratory', order: 1 },
    { id: 'lab.collect', label: 'lab.nav.collect', routeId: 'staff.lab.collect', permission: 'lab.specimen.collect', group: 'laboratory', order: 2 },
    { id: 'lab.receive', label: 'lab.nav.receive', routeId: 'staff.lab.receive', permission: 'lab.specimen.receive', group: 'laboratory', order: 3 },
    { id: 'lab.pending', label: 'lab.nav.pending', routeId: 'staff.lab.pending', permission: 'lab.worklist.read', group: 'laboratory', order: 5 },
    { id: 'lab.verification', label: 'lab.nav.verification', routeId: 'staff.lab.verification', permission: 'lab.result.verify', group: 'laboratory', order: 6 },
    { id: 'lab.approval', label: 'lab.nav.approval', routeId: 'staff.lab.approval', permission: 'lab.result.approve', group: 'laboratory', order: 7 },
    { id: 'lab.ingest_exceptions', label: 'lab.nav.ingest_exceptions', routeId: 'staff.lab.ingest_exceptions', permission: 'lab.result.read', group: 'laboratory', order: 9 },
    { id: 'lab.worksheets', label: 'lab.nav.worksheets', routeId: 'staff.lab.worksheets', permission: 'lab.worklist.read', group: 'laboratory', order: 10 },
    { id: 'lab.qc', label: 'lab.nav.qc', routeId: 'staff.lab.qc', permission: 'lab.qc.capture', group: 'laboratory', order: 11 },
    { id: 'lab.settings', label: 'lab.nav.settings', routeId: 'staff.lab.settings', permission: 'lab.config.manage', group: 'laboratory', order: 12 },
  ],
};
