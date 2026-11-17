// HelpPanel content for helpKey `partners.detail` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Partner',
  sections: [
    { heading: 'Profile and users', body: 'The page shows the profile of the partner organisation and the people who can sign in for it. Each section has its own Save button.' },
    { heading: 'Price list', body: 'Choose the price list that applies to this partner. Changes apply to manifests received after you save.' },
    { heading: 'Stopping access', body: 'Deactivate a partner or a partner user to stop their sign-in. Existing manifests and reports stay in the system.' },
  ],
  links: [{ routeId: 'staff.partners.list', label: 'Partners' }],
};
