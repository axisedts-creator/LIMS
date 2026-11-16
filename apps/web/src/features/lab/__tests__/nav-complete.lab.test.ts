// T0D-NAV-COMPLETE-1 (LD-250): lab manifest = C5 04-UI-UX s1 (12 entries; the table has no group/order columns:
// group = laboratory, order = table order 1..12 so the daily-work entries sort before anatomic/micro at 60+ [CONV]).
// ADMINPAGE-LAB-1 (LD-255, CR T0D-NAV-COMPLETE-1.1): "Worklists" (/lab/worklists) and "Critical values" (/lab/critical-values) now have a page,
// so both rows flip from "absent + CR" to "entry present" (the unconditional block at the end). Pages not in the table (labels, results, specimen, worksheet detail) are not nav entries.
import { describe, expect, it } from 'vitest';
import { loadManifest, pageExists, routes, specSuite } from '../../../core/nav/__tests__/nav-complete.helpers.ts';

specSuite({
  module: 'lab',
  owner: 'C5',
  section: 'C5 04-UI-UX s1',
  rows: [
    { name: 'Status board', path: '/lab/status-board', permission: 'lab.status_board.read', group: 'laboratory', order: 1, routeId: 'staff.lab.status_board' },
    { name: 'Collect & dispatch', path: '/lab/collect', permission: 'lab.specimen.collect', group: 'laboratory', order: 2 },
    { name: 'Receive', path: '/lab/receive', permission: 'lab.specimen.receive', group: 'laboratory', order: 3 },
    { name: 'Worklists', path: '/lab/worklists', permission: 'lab.worklist.read', group: 'laboratory', order: 4, routeId: 'staff.lab.worklists' },
    { name: 'Pending', path: '/lab/pending', permission: 'lab.worklist.read', group: 'laboratory', order: 5 },
    { name: 'Verify', path: '/lab/verification', permission: 'lab.result.verify', group: 'laboratory', order: 6 },
    { name: 'Approve', path: '/lab/approval', permission: 'lab.result.approve', group: 'laboratory', order: 7 },
    { name: 'Critical values', path: '/lab/critical-values', permission: 'lab.critical_value.read', group: 'laboratory', order: 8, routeId: 'staff.lab.critical_values' },
    { name: 'Instrument exceptions', path: '/lab/ingest-exceptions', permission: 'lab.result.read', group: 'laboratory', order: 9, routeId: 'staff.lab.ingest_exceptions' },
    { name: 'Worksheets', path: '/lab/worksheets', permission: 'lab.worklist.read', group: 'laboratory', order: 10 },
    { name: 'QC results', path: '/lab/qc', permission: 'lab.qc.capture', group: 'laboratory', order: 11 },
    { name: 'Lab settings', path: '/lab/settings', permission: 'lab.config.manage', group: 'laboratory', order: 12 },
  ],
});

describe('ADMINPAGE-LAB-1 (LD-255): the two lab pages exist and their entries are present (no longer absent + CR)', () => {
  it.each([
    ['/lab/worklists', 'lab.worklists', 'staff.lab.worklists'],
    ['/lab/critical-values', 'lab.critical_values', 'staff.lab.critical_values'],
  ])('%s: page.tsx exists, ONE staff_web route row, manifest entry %s -> %s', async (path, id, routeId) => {
    expect(pageExists(path), `page ${path}`).toBe(true);
    expect(routes.filter((r) => r.origin === 'staff_web' && r.path === path)).toHaveLength(1);
    const m = await loadManifest('lab');
    const e = m.entries.find((x) => x.id === id);
    expect(e, `entry ${id}`).toBeTruthy();
    expect(e!.routeId).toBe(routeId);
  });
});
