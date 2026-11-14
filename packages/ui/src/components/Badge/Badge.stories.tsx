import { Badge } from './Badge';

export default { title: 'Layout/Badge', component: Badge };

export const Neutral = { args: { children: '12' } };
export const Info = { args: { tone: 'info', children: 'New' } };
export const Danger = { args: { tone: 'danger', children: '3 overdue' } };
