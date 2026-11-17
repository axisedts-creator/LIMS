// HelpPanel content for helpKey `partners.order` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Sample',
  sections: [
    { heading: 'Details', body: 'The page shows the registration number, the tests ordered and the current tracking status. The status chip is the quickest way to see where the sample is.' },
    { heading: 'Reports', body: 'When the lab releases a report for your organisation it appears here and in the Reports list. Reports are never e-mailed to you as attachments.' },
    { heading: 'Something looks wrong', body: 'If a detail is wrong, contact the lab and quote the registration number. You cannot change a sample after the lab has received it.' },
  ],
  links: [{ routeId: 'partner.report', label: 'Report' }],
};
