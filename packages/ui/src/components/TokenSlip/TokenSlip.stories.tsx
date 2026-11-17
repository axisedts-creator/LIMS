import type { IsoUtc } from '../_shared/dates';
import { TokenSlip } from './TokenSlip';

export default { title: 'Display/TokenSlip', component: TokenSlip };

export const Default = {
  args: {
    labName: 'Synthetic Diagnostics Lab',
    heading: 'Sample collection',
    big: 'B-002',
    lines: ['Please wait for your number'],
    issuedAt: '2026-01-15T04:30:00.000Z' as IsoUtc,
  },
};
