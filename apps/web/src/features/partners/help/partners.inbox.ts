// HelpPanel content for helpKey `partners.inbox` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Partner manifests',
  sections: [
    { heading: 'What this list is', body: 'The inbox lists manifests that partner organisations have submitted. Use it to find a manifest and receive the samples that arrived with it.' },
    { heading: 'Filters', body: 'Filter by partner, by status and by whether samples are missing. A manifest is finished when every line has been received or marked as not received.' },
    { heading: 'Permission', body: 'You need the receive permission for manifests to open this page and to receive samples.' },
  ],
  links: [{ routeId: 'staff.partners.manifest', label: 'Receive a manifest' }],
};
