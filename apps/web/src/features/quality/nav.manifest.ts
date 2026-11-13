// C9 04-UI-UX §1.1 (verbatim). Validated against contracts/routes.yaml by core/nav/build-nav.ts.
// Route ids staff.quality.* (other than qc_run) come from C0-0C (06-PLAN row 80); lj_chart and tat_alerts are named by the plan.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'quality',
  entries: [
    { id: 'quality.status', label: 'quality.nav.status', routeId: 'staff.quality.status', permission: 'quality.qc_run.read', group: 'quality', order: 10, icon: 'chart' },
    { id: 'quality.runs', label: 'quality.nav.runs', routeId: 'staff.quality.runs', permission: 'quality.qc_run.read', group: 'quality', order: 20, icon: 'table' },
    { id: 'quality.lj_chart', label: 'quality.nav.lj_chart', routeId: 'staff.quality.lj_chart', permission: 'quality.qc_run.read', group: 'quality', order: 30, icon: 'chart' },
    { id: 'quality.observations', label: 'quality.nav.observations', routeId: 'staff.quality.observations', permission: 'quality.qc_run.read', group: 'quality', order: 40, icon: 'table' },
    { id: 'quality.setup', label: 'quality.nav.setup', routeId: 'staff.quality.setup', permission: 'quality.qc_run.read', group: 'quality', order: 50, icon: 'settings' },
    { id: 'quality.autoverify', label: 'quality.nav.autoverify', routeId: 'staff.quality.autoverify', permission: 'quality.autoverify.read', group: 'quality', order: 60, icon: 'check' },
    { id: 'quality.tat_alerts', label: 'quality.nav.tat_alerts', routeId: 'staff.quality.tat_alerts', permission: 'quality.tat_alert.read', group: 'quality', order: 70, icon: 'clock' },
    { id: 'quality.settings', label: 'quality.nav.settings', routeId: 'staff.quality.settings', permission: 'quality.qc_run.read', group: 'quality', order: 80, icon: 'settings' },
  ],
};
