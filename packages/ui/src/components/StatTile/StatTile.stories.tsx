import { StatTile } from './StatTile';

export default { title: 'Data display/StatTile', component: StatTile, args: { label: 'Pending reports', value: '14' } };

export const Default = {};
export const BetterTrend = { args: { label: 'Median TAT', value: '42 min', delta: { value: '5%', direction: 'down', isGood: true } } };
export const WorseTrend = { args: { label: 'Rejected specimens', value: '9', delta: { value: '3', direction: 'up', isGood: false } } };
export const AsLink = { args: { href: '/lab/reports?status=pending' } };
