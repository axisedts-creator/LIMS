import { FreshnessBadge } from './FreshnessBadge';

export default { title: 'Data/FreshnessBadge', component: FreshnessBadge };

export const Fresh = { args: { refreshedAt: '2026-11-06T04:15:00Z', isStale: false } };
export const Stale = { args: { refreshedAt: '2026-11-06T04:15:00Z', isStale: true, reason: 'refresh_failed' } };
