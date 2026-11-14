// HelpPanel content for helpKey `partners.manifests` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Manifests',
  sections: [
    { heading: 'What a manifest is', body: 'A manifest is the list of patient samples you send to the lab in one batch. Each line is one patient with the tests you want. Start a new manifest from this list.' },
    { heading: 'Statuses', body: 'Every manifest shows its status as a coloured chip with an icon and a word: Draft, Submitted, Received, or Withdrawn. Open a manifest to see what the lab has done with it.' },
    { heading: 'Finding a manifest', body: 'Use the search and the status filter above the list. Drafts that nobody submits are removed by the lab after the number of days set in the partner settings.' },
  ],
  links: [{ routeId: 'partner.manifest', label: 'Manifest' }],
};
