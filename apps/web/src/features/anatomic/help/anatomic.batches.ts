// HelpPanel content for helpKey `anatomic.batches` (C11 04-UI-UX §4.6). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Molecular batches',
  sections: [
    { heading: 'Batch list', body: 'Each row is one molecular run: batch number, assay, status, kit lot, run time and how many of the available positions are used. Use Status and Assay to narrow the list. Open a batch to see its samples.' },
    { heading: 'New batch', body: 'Choose the assay (required) and add the kit, instrument, run time and capacity if you know them. Capacity is the number of positions, from 1 to 384; the default is 96.' },
  ],
  shortcuts: [],
  links: [{ routeId: 'staff.anatomic.worklist', label: 'Pathology cases' }],
};
