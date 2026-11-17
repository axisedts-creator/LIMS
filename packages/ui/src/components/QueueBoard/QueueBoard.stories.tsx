import type { IsoUtc } from '../_shared/dates';
import { QueueBoard } from './QueueBoard';

export default { title: 'Display/QueueBoard', component: QueueBoard };

const base = {
  title: 'Synthetic Diagnostics Lab',
  subtitle: 'Central collection',
  nowCalling: [
    { token: 'A-012', counter: 'Counter 2', queue: 'Blood', isNew: true },
    { token: 'B-004', counter: 'Counter 1', queue: 'X-ray', isNew: false },
  ],
  waiting: [
    { queue: 'Blood', count: 7 },
    { queue: 'X-ray', count: 2 },
  ],
  serverTime: '2026-01-15T04:30:00.000Z' as IsoUtc,
  soundEnabled: false,
};

export const Live = { args: { ...base, connection: 'live' } };
export const Stale = { args: { ...base, connection: 'stale', staleSince: '2026-01-15T04:25:00.000Z' as IsoUtc } };
export const Unpaired = { args: { ...base, nowCalling: [], waiting: [], connection: 'unpaired' } };
