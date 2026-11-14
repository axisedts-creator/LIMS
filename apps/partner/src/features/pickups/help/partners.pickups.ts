// HelpPanel content for helpKey `partners.pickups` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Pickups',
  sections: [
    { heading: 'What this list shows', body: 'Pickups lists the sample collections you asked the lab to make at your premises, with the date, the time window and the status of each request.' },
    { heading: 'Statuses', body: 'Each request shows a status chip with an icon and a word, for example Requested, Scheduled, Collected or Cancelled. The lab updates the status as it works.' },
    { heading: 'New request', body: 'Press Request pickup to ask for a new collection. You can only book a date within the number of days ahead that the lab allows.' },
  ],
  links: [{ routeId: 'partner.manifest', label: 'Manifest' }],
};
