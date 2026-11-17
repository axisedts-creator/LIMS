import { TimeSeriesChart } from './TimeSeriesChart';

const series = [
  {
    id: 'hb',
    label: 'Haemoglobin',
    points: [
      { at: '2025-01-10T06:00:00Z', value: '12.10' },
      { at: '2025-02-10T06:00:00Z', value: '13.50' },
      { at: '2025-03-10T06:00:00Z', value: '9.25' },
      { at: '2025-04-10T06:00:00Z', value: '14.00' },
    ],
  },
];

export default { title: 'Data display/TimeSeriesChart', component: TimeSeriesChart, args: { title: 'Haemoglobin trend', series, unit: 'g/dL' } };

export const Trend = {};
export const WithReferenceBand = { args: { referenceBand: { low: '11.5', high: '15.5' } } };
export const NoData = { args: { series: [] } };
