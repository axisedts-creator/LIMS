// HelpPanel content for helpKey `instruments.messages` (SCR-09). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Messages',
  sections: [
    { heading: 'Messages', body: 'Every message received from an instrument, with its outcome: Parsed, Shadow (commissioning, not sent to the laboratory), Quarantined or Rejected.' },
    { heading: 'Barcode search', body: 'Scan or type a sample barcode to find its messages. The barcode is not kept in the page address or browser history.' },
    { heading: 'Raw messages', body: 'Viewing raw messages is recorded.' },
  ],
  shortcuts: [{ keys: '/', action: 'Focus barcode search' }],
  links: [{ routeId: 'staff.instruments.instruments', label: 'Instruments' }],
};
