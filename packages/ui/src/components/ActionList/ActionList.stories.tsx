import { ActionList } from './ActionList';

export default { title: 'Data/ActionList', component: ActionList };

// Sample data only (layout), most urgent first.
export const NeedsYou = {
  args: {
    label: 'Needs you',
    items: [
      { id: 'crit', title: 'Critical results to call', detail: 'Not yet acknowledged by a clinician', count: 3, tone: 'danger', icon: 'warning', href: '#critical' },
      { id: 'tat', title: 'Samples past turnaround time', detail: 'In testing for more than 24 hours', count: 6, tone: 'warning', icon: 'info', href: '#tat' },
      { id: 'verify', title: 'Results to verify', detail: 'Entered and waiting for a second check', count: 12, tone: 'info', icon: 'current', href: '#verify' },
      { id: 'release', title: 'Reports ready to release', detail: 'Verified and signed', count: 5, tone: 'success', icon: 'success', href: '#release' },
    ],
  },
};
