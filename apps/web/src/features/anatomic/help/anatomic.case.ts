// HelpPanel content for helpKey `anatomic.case` (C11 04-UI-UX §4.2). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Pathology case',
  sections: [
    { heading: 'Accession', body: 'A received case needs an accession number. Open Accession, enter the site of every part (required), an optional description and clinical history, choose a pathologist if you know one, then press Accession.' },
    { heading: 'Parts & gross', body: 'Each part has its site, description and gross record: description text, number of pieces, dimensions (fill Length, then Width, then Depth), weight and a Gross complete switch. Save part saves the part you are working in. Type ; and a short code, then Tab, to insert a text template.' },
    { heading: 'Moving the case on', body: 'Start processing and Mark ready for reporting appear when the case is in the right step. If someone else changed the case, choose Reload and try again.' },
    { heading: 'Banners', body: 'Banners above the details warn about a missing pathology profile, a rejected specimen, a test removed from the order, a billed add-on without a result, and a revision or amendment in progress.' },
  ],
  shortcuts: [
    { keys: 'Alt+O', action: 'Overview tab' },
    { keys: 'Alt+G', action: 'Parts & gross tab' },
    { keys: 'Alt+B', action: 'Blocks & slides tab' },
    { keys: 'Alt+T', action: 'Stains tab' },
    { keys: 'Alt+I', action: 'Images tab' },
    { keys: 'Alt+R', action: 'Report tab' },
    { keys: 'Alt+A', action: 'Open the Accession dialog (when allowed)' },
    { keys: 'Alt+L', action: 'Open the labels page for blocks' },
    { keys: 'Alt+S', action: 'Save the form you are working in' },
    { keys: 'Alt+U', action: 'Open the Sign out dialog (when allowed)' },
  ],
  links: [{ routeId: 'staff.anatomic.worklist', label: 'Pathology cases' }],
};
