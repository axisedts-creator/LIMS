// T0D-NAV-COMPLETE-1 (LD-250): front desk manifest = C4 04-UI-UX s3 (registration, exists), s6, s7, s8.11 (front-desk settings).
// The C4 spec names the screens and paths, not group/order/permission columns: permission = the API operation floor of the page
// (contracts/openapi/frontdesk.yaml x-permission), group = front_desk, order = the section order s3, s6, s7, s8.11 [CONV].
// /frontdesk/settings has no page under (staff) today -> no entry and a non-blocking CR (LD-250: never stub a page).
import { specSuite } from '../../../core/nav/__tests__/nav-complete.helpers.ts';

specSuite({
  module: 'frontdesk',
  owner: 'C4',
  section: 'C4 04-UI-UX s3, s6, s7, s8.11',
  rows: [
    { name: 'New registration', path: '/frontdesk/registrations/new', permission: 'frontdesk.registration.create', group: 'front_desk', order: 10, routeId: 'staff.frontdesk.registration_new' },
    { name: 'Front-desk worklist', path: '/frontdesk/worklist', permission: 'frontdesk.order.read', group: 'front_desk', order: 20 },
    { name: 'Discount approvals', path: '/frontdesk/discount-approvals', permission: 'frontdesk.discount.approve', group: 'front_desk', order: 30 },
    { name: 'Front desk settings (discount self-limit, absolute max %)', path: '/frontdesk/settings', permission: 'frontdesk.settings.manage', group: 'front_desk', order: 40 },
  ],
});
