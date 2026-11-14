// HelpPanel content for helpKey `anatomic.batch` (C11 04-UI-UX §4.6). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Molecular batch',
  sections: [
    { heading: 'Adding samples', body: 'Scan or type the accession number of a molecular case. It goes to the next free position. To use a different position, choose an empty position first, then scan.' },
    { heading: 'Removing samples', body: 'Tick the samples to take out and press Remove selected. Positions that show Restricted belong to a centre you cannot see; they can still be ticked and removed by position.' },
    { heading: 'Closing a batch', body: 'Close batch locks the batch: no samples can be added or removed afterwards. Results can still be linked to a closed batch from the case.' },
  ],
  shortcuts: [],
  links: [{ routeId: 'staff.anatomic.batches', label: 'Molecular batches' }],
};
