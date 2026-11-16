// Engagement nav manifest (C16 04-UI-UX s1.3; T0D-NAV-COMPLETE-1, LD-250). ids, routes, permissions, orders, phases are spec-fixed.
// No chords: the spec chord `g m` collides with instruments.messages. /engagement/settings: page built by ADMINPAGE-ENG-1, answers CR T0D-NAV-COMPLETE-1.1.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'engagement',
  entries: [
    { id: 'engagement.queue', label: 'engagement.nav.queue', routeId: 'staff.engagement.queue', permission: 'engagement.queue.operate', group: 'engagement', order: 10, phase: '2' },
    { id: 'engagement.bookings', label: 'engagement.nav.bookings', routeId: 'staff.engagement.bookings', permission: 'engagement.booking.read', group: 'engagement', order: 20, phase: '3' },
    { id: 'engagement.reminders', label: 'engagement.nav.reminders', routeId: 'staff.engagement.reminders', permission: 'engagement.reminder.read', group: 'engagement', order: 30, phase: '2' },
    { id: 'engagement.enquiries', label: 'engagement.nav.enquiries', routeId: 'staff.engagement.enquiries', permission: 'engagement.enquiry.read', group: 'engagement', order: 40, phase: '3' },
    { id: 'engagement.memberships', label: 'engagement.nav.memberships', routeId: 'staff.engagement.memberships', permission: 'engagement.membership.read', group: 'engagement', order: 50, phase: '3' },
    { id: 'engagement.slots', label: 'engagement.nav.slots', routeId: 'staff.engagement.slots', permission: 'engagement.slot.manage', group: 'engagement', order: 60, phase: '3' },
    { id: 'engagement.bookable', label: 'engagement.nav.bookable', routeId: 'staff.engagement.bookable', permission: 'engagement.bookable_item.manage', group: 'engagement', order: 70, phase: '3' },
    { id: 'engagement.queue_setup', label: 'engagement.nav.queue_setup', routeId: 'staff.engagement.queue_setup', permission: 'engagement.queue.manage', group: 'engagement', order: 80, phase: '2' },
    { id: 'engagement.settings', label: 'engagement.nav.settings', routeId: 'staff.engagement.settings', permission: 'engagement.settings.manage', group: 'engagement', order: 90, phase: '2' }, // ADMINPAGE-ENG-1 (LD-255)
  ],
};
