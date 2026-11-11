// C14 04-UI-UX §1 (verbatim paths/permissions). Validated against contracts/routes.yaml by core/nav/build-nav.ts.
// [CONV] ids/labels/group/order/icon are not given by §1. No chords: `g <letter>` is unclaimed by the spec.
// CR C14.T18: routes.yaml has no non-parameterised staff_web row for these three paths yet; build-nav fails until it lands.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'smartreport',
  entries: [
    { id: 'smartreport.summaries', label: 'smartreport.nav.summaries', routeId: 'staff.smartreport.summaries', permission: 'smartreport.summary.read', group: 'reporting', order: 50, icon: 'table' },
    { id: 'smartreport.library', label: 'smartreport.nav.library', routeId: 'staff.smartreport.library', permission: 'smartreport.template.manage', group: 'reporting', order: 60, icon: 'table' },
    { id: 'smartreport.wording', label: 'smartreport.nav.wording', routeId: 'staff.smartreport.wording', permission: 'smartreport.template.manage', group: 'reporting', order: 70, icon: 'table' },
  ],
};
