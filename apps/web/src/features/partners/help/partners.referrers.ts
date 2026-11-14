// HelpPanel content for helpKey `partners.referrers` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Partner doctors',
  sections: [
    { heading: 'Why mapping matters', body: 'Partners add their own referring doctors. Map each one to a doctor record of your lab so that orders and reports go to the right person.' },
    { heading: 'Mapping', body: 'Pick a partner doctor, search for the matching lab doctor and save. If the lab requires a mapped doctor, unmapped lines cannot be converted to orders.' },
    { heading: 'Permission', body: 'You need the permission to map partner doctors to use this page.' },
  ],
  links: [{ routeId: 'staff.partners.list', label: 'Partners' }],
};
