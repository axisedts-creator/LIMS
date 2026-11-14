// HelpPanel content for helpKey `partners.settings` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Partner settings',
  sections: [
    { heading: 'Limits', body: 'Set how many lines a manifest may hold, how long a draft is kept, how far ahead a pickup may be booked and the daily report download limit per user.' },
    { heading: 'Consent statement', body: 'The consent statement is the text a partner user confirms for every patient. Change its version number whenever you change the wording, so old lines keep the text they were confirmed against.' },
    { heading: 'Permission', body: 'You need the permission to manage partners to change these settings. Each section has its own Save button.' },
  ],
  links: [{ routeId: 'staff.partners.list', label: 'Partners' }],
};
