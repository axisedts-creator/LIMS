import { BarChart } from './BarChart';

export default {
  title: 'Data display/BarChart',
  component: BarChart,
  args: { title: 'Reports per month', categories: ['Jan', 'Feb', 'Mar'], series: [{ id: 'a', label: 'Walk-in', values: [5, 8, 3] }, { id: 'b', label: 'Referred', values: [7, 1, 9] }] },
};

export const Grouped = {};
export const Money = { args: { title: 'Collections', series: [{ id: 'c', label: 'Collected', values: [1234500, 987600, 1500000] }], valueFormat: 'money' } };
