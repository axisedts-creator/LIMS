// HelpPanel content for helpKey `partners.manifest` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Manifest',
  sections: [
    { heading: 'Reading the manifest', body: 'The top of the page shows the manifest number and its status. The table lists every line with the patient, the tests requested and the line status.' },
    { heading: 'What you can do', body: 'A draft manifest can be edited and then submitted. A submitted manifest can be printed or withdrawn while the lab has not yet received it. Buttons you are not allowed to use are hidden.' },
    { heading: 'After the lab receives it', body: 'Once the lab receives your samples, each line gets a registration number. Open it from the Samples list to follow tracking and reports.' },
  ],
  links: [{ routeId: 'partner.order', label: 'Sample' }],
};
