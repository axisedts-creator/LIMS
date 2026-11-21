// Lab nav manifest (C5 04-UI-UX s1; T0D-NAV-COMPLETE-1, LD-250). Paths/permissions from the spec table; order = table order [CONV].
// Worklists (/lab/worklists) and Critical values (/lab/critical-values): pages built by ADMINPAGE-LAB-1 (LD-255), answering CR T0D-NAV-COMPLETE-1.1.
// LD-251 (13-M-SERIES s3): sidebar sub-heading "Daily work".
import type { NavManifest } from '../../core/nav/types.ts';

const section = 'core.nav.section.daily_work';

export const navManifest: NavManifest = {
  module: 'lab',
  entries: [
    { id: 'lab.status_board', label: 'lab.nav.status_board', routeId: 'staff.lab.status_board', permission: 'lab.status_board.read', group: 'laboratory', order: 1, section },
    { id: 'lab.collect', label: 'lab.nav.collect', routeId: 'staff.lab.collect', permission: 'lab.specimen.collect', group: 'laboratory', order: 2, section },
    { id: 'lab.receive', label: 'lab.nav.receive', routeId: 'staff.lab.receive', permission: 'lab.specimen.receive', group: 'laboratory', order: 3, section },
    { id: 'lab.worklists', label: 'lab.nav.worklists', routeId: 'staff.lab.worklists', permission: 'lab.worklist.read', group: 'laboratory', order: 4, section },
    { id: 'lab.pending', label: 'lab.nav.pending', routeId: 'staff.lab.pending', permission: 'lab.worklist.read', group: 'laboratory', order: 5, section },
    { id: 'lab.verification', label: 'lab.nav.verification', routeId: 'staff.lab.verification', permission: 'lab.result.verify', group: 'laboratory', order: 6, section },
    { id: 'lab.approval', label: 'lab.nav.approval', routeId: 'staff.lab.approval', permission: 'lab.result.approve', group: 'laboratory', order: 7, section },
    { id: 'lab.critical_values', label: 'lab.nav.critical_values', routeId: 'staff.lab.critical_values', permission: 'lab.critical_value.read', group: 'laboratory', order: 8, section },
    { id: 'lab.ingest_exceptions', label: 'lab.nav.ingest_exceptions', routeId: 'staff.lab.ingest_exceptions', permission: 'lab.result.read', group: 'laboratory', order: 9, section },
    { id: 'lab.worksheets', label: 'lab.nav.worksheets', routeId: 'staff.lab.worksheets', permission: 'lab.worklist.read', group: 'laboratory', order: 10, section },
    { id: 'lab.qc', label: 'lab.nav.qc', routeId: 'staff.lab.qc', permission: 'lab.qc.capture', group: 'laboratory', order: 11, section },
    { id: 'lab.settings', label: 'lab.nav.settings', routeId: 'staff.lab.settings', permission: 'lab.config.manage', group: 'laboratory', order: 12, section },
  ],
};
