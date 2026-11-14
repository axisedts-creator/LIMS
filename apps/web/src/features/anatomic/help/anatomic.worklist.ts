// HelpPanel content for helpKey `anatomic.worklist` (C11 04-UI-UX §4.1). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Pathology cases',
  sections: [
    { heading: 'Finding a case', body: 'Scan or type an accession, block or slide label in the lookup field and press Enter. The matching case opens. Labels are never stored in the address bar.' },
    { heading: 'Queues', body: 'To accession: cases received from the lab that still need an accession number. Grossing, Bench and Reporting follow the case through the lab. Awaiting lab approval, Signed out, Cancelled and All complete the list. Each tab shows the cases of that queue, urgent first, then oldest first.' },
    { heading: 'Filters', body: 'Narrow a queue by case kind, centre, priority, pathologist or received date. Reset filters clears them.' },
    { heading: 'Flags', body: 'Profile missing: the test has no pathology profile. Specimen rejected: a part was rejected in the lab. Change open: a revision or amendment is in progress. Stains pending: stain orders are waiting.' },
  ],
  shortcuts: [{ keys: 'Alt+F', action: 'Move to the lookup field' }],
  links: [{ routeId: 'staff.anatomic.tracking', label: 'Block & slide tracking' }],
};
