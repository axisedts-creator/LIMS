// HelpPanel content for helpKey `partners.manifest` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Receive a manifest',
  sections: [
    { heading: 'Matching the box', body: 'Check the samples against the lines of the manifest. Mark each line as received, or record why a sample is missing or cannot be accepted.' },
    { heading: 'Creating orders', body: 'Received lines are converted into lab orders. If a conversion fails the line shows an error you can retry; nothing is lost and no duplicate order is created.' },
    { heading: 'Consent', body: 'The partner confirms patient consent for each line. The lab relies on that confirmation, so report doubts to your supervisor instead of ignoring them.' },
  ],
  links: [{ routeId: 'staff.partners.inbox', label: 'Partner manifests' }],
};
