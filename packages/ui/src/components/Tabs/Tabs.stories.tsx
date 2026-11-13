import { Tabs } from './Tabs';

export default {
  title: 'Shell/Tabs',
  component: Tabs,
  args: {
    items: [
      { id: 'a', label: 'Overview' },
      { id: 'b', label: 'Results', badge: '3' },
      { id: 'c', label: 'History' },
    ],
    selectedId: 'a',
    onChange: () => {},
  },
};

export const Default = {};
export const WithCounts = {
  args: {
    items: [
      { id: 'a', label: 'To collect', count: 12 },
      { id: 'b', label: 'To receive', count: 0 },
      { id: 'c', label: 'Rejected', count: 3 },
    ],
  },
};
