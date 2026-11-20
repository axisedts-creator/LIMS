// T0D-NAV-COMPLETE-1 (LD-250): front desk manifest = C4 04-UI-UX s3 (registration, exists), s6, s7, s8.11 (front-desk settings).
// The C4 spec names the screens and paths, not group/order/permission columns: permission = the API operation floor of the page
// (contracts/openapi/frontdesk.yaml x-permission), group = front_desk, order = the section order s3, s6, s7, s8.11 [CONV].
// ADMINPAGE-FD-1 (LD-255): /frontdesk/settings now has a page, so its row flips from "absent + CR" to "entry present" (asserted unconditionally below).
import { describe, expect, it } from 'vitest';
import { loadManifest, pageExists, routes, specSuite } from '../../../core/nav/__tests__/nav-complete.helpers.ts';
import { t } from '../../../core/i18n/messages.ts';

specSuite({
  module: 'frontdesk',
  owner: 'C4',
  section: 'C4 04-UI-UX s3, s6, s7, s8.11',
  rows: [
    { name: 'New registration', path: '/frontdesk/registrations/new', permission: 'frontdesk.registration.create', group: 'front_desk', order: 10, routeId: 'staff.frontdesk.registration_new' },
    { name: 'Front-desk worklist', path: '/frontdesk/worklist', permission: 'frontdesk.order.read', group: 'front_desk', order: 20 },
    { name: 'Discount approvals', path: '/frontdesk/discount-approvals', permission: 'frontdesk.discount.approve', group: 'front_desk', order: 30 },
    { name: 'Front desk settings', path: '/frontdesk/settings', permission: 'frontdesk.settings.manage', group: 'front_desk', order: 40, routeId: 'staff.frontdesk.settings' },
  ],
});

describe('ADMINPAGE-FD-1: Front desk settings entry is present (flipped from absent + CR)', () => {
  it('the page exists and the manifest has the entry in group front_desk, order 40, permission frontdesk.settings.manage, spec label', async () => {
    expect(pageExists('/frontdesk/settings')).toBe(true);
    const m = await loadManifest('frontdesk');
    const e = m.entries.find((x) => x.routeId === 'staff.frontdesk.settings');
    expect(e, 'entry staff.frontdesk.settings').toBeTruthy();
    expect(e).toMatchObject({ permission: 'frontdesk.settings.manage', group: 'front_desk', order: 40 });
    expect(t(e!.label)).toBe('Front desk settings');
    expect(routes.filter((r) => r.path === '/frontdesk/settings' && r.origin === 'staff_web')).toHaveLength(1);
  });
});
