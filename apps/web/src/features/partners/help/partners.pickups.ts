// HelpPanel content for helpKey `partners.pickups` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Partner pickups',
  sections: [
    { heading: 'The queue', body: 'The queue lists pickup requests from partner organisations, with the date, the time window and the status. Work through it from the oldest date.' },
    { heading: 'Scheduling', body: 'Open a request to schedule it, assign it, mark it as collected or decline it with a reason. The partner sees every status change on their own Pickups page.' },
    { heading: 'Permission', body: 'You need the permission to manage partner pickups to change a request.' },
  ],
  links: [{ routeId: 'staff.partners.inbox', label: 'Partner manifests' }],
};
