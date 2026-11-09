// HelpPanel content for helpKey `instruments.instruments` (SCR-05). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Instruments',
  sections: [
    { heading: 'Instruments', body: 'Each analyser connected through an agent is an instrument. Its protocol, connection and driver come from the instrument\'s LIS/host interface manual.' },
    { heading: 'States', body: 'Draft and Commissioning instruments send no results to the laboratory. Only a Live instrument with a verified driver sends results.' },
    { heading: 'Unmapped codes', body: 'Codes the instrument sent that have no test mapping. Map them before going live.' },
  ],
  shortcuts: [{ keys: 'Alt+I', action: 'New instrument' }],
  links: [
    { routeId: 'staff.instruments.agents', label: 'Agents' },
    { routeId: 'staff.instruments.messages', label: 'Messages' },
  ],
};
