import { Timeline } from './Timeline';

const items = [
  { at: '2025-04-14T06:15:00Z', label: 'Received', actor: 'Asha K.' },
  { at: '2025-04-14T09:00:00Z', label: 'Result entered', actor: 'Ravi T.' },
  { at: '2025-04-15T03:30:00Z', label: 'Report published', tone: 'success' as const },
  { at: '2025-04-16T03:30:00Z', label: 'Amended', tone: 'warning' as const },
];

export default { title: 'Data display/Timeline', component: Timeline, args: { items } };

export const Default = {};
export const Empty = { args: { items: [] } };
