import { FilterBar, type FilterDef } from './FilterBar';

const filters: FilterDef[] = [
  { id: 'status', label: 'Status', kind: 'select', options: [{ value: 'received', label: 'Received' }, { value: 'rejected', label: 'Rejected' }] },
  { id: 'tags', label: 'Tags', kind: 'select', multiple: true, options: [{ value: 'urgent', label: 'Urgent' }, { value: 'stat', label: 'STAT' }] },
  { id: 'q', label: 'Search', kind: 'text', maxLength: 40 },
  { id: 'period', label: 'Period', kind: 'date_range' },
  { id: 'dept', label: 'Department', kind: 'coded', codedSet: 'department', options: [{ code: 'HAEM', display: 'Haematology' }, { code: 'BIOC', display: 'Biochemistry' }] },
];

export default { title: 'Data display/FilterBar', component: FilterBar, args: { filters, value: {}, onChange: () => {}, onReset: () => {} } };

export const Empty = {};
export const WithValues = { args: { value: { status: 'received', tags: ['urgent'], q: 'hb', period: ['2025-07-01', '2025-07-10'] } } };
