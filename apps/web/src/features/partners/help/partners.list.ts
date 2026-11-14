// HelpPanel content for helpKey `partners.list` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Partners',
  sections: [
    { heading: 'Partner organisations', body: 'This list holds every partner organisation that can send samples to your lab. Search by name and open a partner to see its users and settings.' },
    { heading: 'Adding a partner', body: 'Users with permission to manage partners see New partner. Create the partner first, then invite its first user from the partner page.' },
  ],
  links: [{ routeId: 'staff.partners.partner', label: 'Partner' }],
};
