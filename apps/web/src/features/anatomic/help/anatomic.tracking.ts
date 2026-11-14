// HelpPanel content for helpKey `anatomic.tracking` (C11 04-UI-UX §4.5). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Block & slide tracking',
  sections: [
    { heading: 'Lookup', body: 'Scan or type a block or slide label. You see the case, the part, where the block or slide is now and its movement history, newest first. Labels are never kept in the address bar.' },
    { heading: 'Basket mode', body: 'Switch on Basket mode to scan several blocks or slides into a list, then press Record movement. Each item shows whether it was recorded. Items that could not be recorded stay in the list.' },
    { heading: 'Movements', body: 'Store needs a location. Send out needs a destination and a reason. Discard needs a reason and asks you to confirm, because discarded blocks and slides cannot be used again.' },
    { heading: 'Sent out', body: 'The Sent out tab lists blocks that are away, oldest first, with where they went and why.' },
  ],
  shortcuts: [{ keys: 'Alt+V', action: 'Record movement for the basket' }],
  links: [{ routeId: 'staff.anatomic.worklist', label: 'Pathology cases' }],
};
