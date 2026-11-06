import { DiffTable } from './DiffTable';

export default { title: 'Data/DiffTable', component: DiffTable };

export const Default = {
  args: {
    rows: [
      { label: 'Name', before: 'Lab Tech', after: 'Lab Technician', changed: true },
      { label: 'Active', before: 'yes', after: 'yes', changed: false },
      { label: 'Notes', before: 'x'.repeat(300), after: 'y'.repeat(300), changed: true },
    ],
  },
};
