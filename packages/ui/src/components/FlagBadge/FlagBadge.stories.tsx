import { FlagBadge } from './FlagBadge';

export default { title: 'Data/FlagBadge', component: FlagBadge };

export const All = {
  render: () => (
    <p>
      {(['N', 'L', 'H', 'A', 'LL', 'HH'] as const).map((f) => (
        <FlagBadge key={f} flag={f} showNormal />
      ))}
    </p>
  ),
};
