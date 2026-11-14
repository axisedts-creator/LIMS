// HelpPanel content for helpKey `engagement.booking_new` (C16 T-DOC1). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'New booking',
  sections: [
    { heading: 'Filling the form', body: 'Search the patient by name or code (three letters or more), choose a centre visit or home collection, then pick a date and one of the open slots. Slots that are already full cannot be chosen.' },
    { heading: 'Tests and saving', body: 'Add up to 20 tests. Prices shown are indicative only; the bill is made at registration. Press Ctrl+Enter to save. You then land on the new booking.' },
  ],
  shortcuts: [
    { keys: 'Ctrl+Enter', action: 'Save the booking' },
  ],
  links: [{ routeId: 'staff.engagement.bookings', label: 'Bookings' }],
};
