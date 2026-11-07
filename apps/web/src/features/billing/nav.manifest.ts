// Billing nav manifest (04-UI-UX §3). Only parameterless staff_web routes are nav entries; invoice and credit-party
// detail pages are reached from lists. routeId/permission copied from contracts/routes.yaml.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'billing',
  entries: [
    {
      id: 'billing.daily_cash',
      label: 'nav.billing.daily_cash',
      routeId: 'staff.billing.daily_cash',
      permission: 'billing.cash_report.read',
      group: 'billing',
      order: 10,
    },
  ],
};
