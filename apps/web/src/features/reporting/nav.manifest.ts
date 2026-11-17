// Reporting nav manifest (04-UI-UX §3). Only parameterless staff_web routes are nav entries; report, narrative, delivery and template
// detail pages are reached from lists. routeId/permission copied from contracts/routes.yaml.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'reporting',
  entries: [
    { id: 'reporting.worklist', label: 'nav.reporting.worklist', routeId: 'staff.reporting.worklist', permission: 'reporting.report.read', group: 'reporting', order: 10 },
    { id: 'reporting.outsourced', label: 'nav.reporting.outsourced', routeId: 'staff.reporting.outsourced', permission: 'reporting.outsourced.attach', group: 'reporting', order: 20 },
    { id: 'reporting.messages', label: 'nav.reporting.messages', routeId: 'staff.reporting.messages', permission: 'reporting.message_template.manage', group: 'reporting', order: 30 },
    { id: 'reporting.settings', label: 'nav.reporting.settings', routeId: 'staff.reporting.settings', permission: 'reporting.settings.manage', group: 'reporting', order: 40 },
  ],
};
