import { BarChart } from '../BarChart/BarChart';
import { TimeSeriesChart } from '../TimeSeriesChart/TimeSeriesChart';
import { ChartCard } from './ChartCard';

export default { title: 'Data display/ChartCard', component: ChartCard };

const SERIES = [{ id: 's', label: 'Reports', points: [{ at: '2026-11-10T00:00:00Z', value: '4' }, { at: '2026-11-11T00:00:00Z', value: '9' }, { at: '2026-11-12T00:00:00Z', value: '7' }] }];

export const TimeSeries = {
  render: () => (
    <ChartCard title="Reports per day" period={<span>Last 7 days</span>} note="Counts finished reports only.">
      <TimeSeriesChart title="Reports per day" series={SERIES} />
    </ChartCard>
  ),
};
export const Bars = {
  render: () => (
    <ChartCard title="Revenue by department (NPR)">
      <BarChart title="Revenue by department (NPR)" categories={['Biochemistry', 'Haematology']} series={[{ id: 'r', label: 'Revenue', values: [12000, 8500] }]} />
    </ChartCard>
  ),
};
export const Empty = {
  render: () => (
    <ChartCard title="Reports per day" isEmpty>
      <TimeSeriesChart title="Reports per day" series={[]} />
    </ChartCard>
  ),
};
