import { StatusChip } from './StatusChip';

export default { title: 'Data/StatusChip', component: StatusChip };

export const Specimen = {
  render: () => (
    <p>
      {['ordered', 'collected', 'resulted', 'approved', 'rejected', 'unknown_code'].map((s) => (
        <StatusChip key={s} kind="specimen" status={s} />
      ))}
    </p>
  ),
};
export const Generic = { args: { kind: 'generic', status: 'on_hold', label: 'QC hold', tone: 'warning' } };
