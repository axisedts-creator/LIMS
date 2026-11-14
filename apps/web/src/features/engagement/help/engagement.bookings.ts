// HelpPanel content for helpKey `engagement.bookings` (C16 T-DOC1). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Bookings',
  sections: [
    { heading: 'What you see', body: 'Bookings shows patient visits and home collections for the days you pick. By default it lists today, for your working centre, with Confirmed and Checked in bookings.' },
    { heading: 'What you can do', body: 'Open a booking to see its details. Check in a patient when they arrive, or cancel with a reason. A booking made in the patient app shows Source App; one made here shows Staff.' },
  ],
  shortcuts: [
    { keys: 'Alt+B', action: 'New booking' },
    { keys: 'Alt+C', action: 'Check in the selected booking' },
    { keys: 'Alt+X', action: 'Cancel the selected booking' },
  ],
  links: [{ routeId: 'staff.engagement.bookings', label: 'Bookings' }],
};
