import { StatTile, StatTileRow } from './StatTile';

export default { title: 'Data display/StatTile', component: StatTile, args: { label: 'Pending reports', value: '14' } };

export const Default = {};
export const BetterTrend = { args: { label: 'Median TAT', value: '42 min', delta: { value: '5%', direction: 'down', isGood: true } } };
export const WorseTrend = { args: { label: 'Rejected specimens', value: '9', delta: { value: '3', direction: 'up', isGood: false } } };
export const AsLink = { args: { href: '/lab/reports?status=pending' } };
export const Stale = { args: { isStale: true, staleReason: 'refresh_lagging' } };
export const Row = {
  render: () => (
    <StatTileRow>
      <StatTile label="Pending" value="14" />
      <StatTile label="In progress" value="6" />
      <StatTile label="Done today" value="31" />
      <StatTile label="Rejected" value="2" />
    </StatTileRow>
  ),
};
export const RowWithLead = {
  render: () => (
    <StatTileRow lead>
      <StatTile label="Revenue today (NPR)" value="48,250.00" />
      <StatTile label="Invoices" value="37" />
      <StatTile label="Unpaid" value="4" />
    </StatTileRow>
  ),
};
