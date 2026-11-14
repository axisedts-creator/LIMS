import { DataTable, type ColumnDef } from './DataTable';

type Row = { id: string; name: string; qty: number; at: string };
const rows: Row[] = [
  { id: 'r1', name: 'Alpha', qty: 3, at: '2025-07-01' },
  { id: 'r2', name: 'Bravo', qty: 12, at: '2025-07-02' },
  { id: 'r3', name: 'Charlie', qty: 7, at: '2025-07-03' },
];
const columns: ColumnDef<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortKey: 'name', isRowHeader: true },
  { id: 'qty', header: 'Quantity', cell: (r) => String(r.qty), align: 'end' },
  { id: 'at', header: 'Received', cell: (r) => r.at, sortKey: 'received_at' },
];
const base = {
  caption: 'Specimens',
  columns,
  rows,
  getRowId: (r: Row) => r.id,
  emptyState: { title: 'No specimens yet', body: 'Receive a specimen to see it here' },
};

export default { title: 'Data display/DataTable', component: DataTable, args: base };

export const Default = { args: { sort: { value: '-name', onChange: () => {} }, page: { hasNext: true, hasPrevious: false, onNext: () => {}, onPrevious: () => {}, limit: 25 } } };
export const MultiSelect = { args: { selection: { mode: 'multiple', selectedIds: new Set(['r1']), onChange: () => {} }, rowActions: () => [{ id: 'view', label: 'View' }], onRowActionMenu: () => {} } };
export const Loading = { args: { isLoading: true } };
export const Empty = { args: { rows: [] } };
// T0D-UI-R03 (LD-140): density, row status, bulk bar.
const stateOf: Record<string, string> = { r1: 'rejected', r2: 'approved', r3: 'collected' };
const rowStatus = (r: Row) => ({ kind: 'specimen' as const, status: stateOf[r.id] ?? 'ordered' });
export const Compact = { args: { density: 'compact', rowStatus } };
export const RowStatus = { args: { density: 'comfortable', rowStatus } };
export const BulkSelected = {
  args: {
    rowStatus,
    selection: { mode: 'multiple', selectedIds: new Set(['r1', 'r2']), onChange: () => {} },
    bulkActions: [{ id: 'export', label: 'Export' }, { id: 'void', label: 'Void', isDanger: true }],
    onBulkAction: () => {},
  },
};
export const Failed ={ args: { error: { title: 'Could not load specimens', requestId: 'req-7f3a9c21', onRetry: () => {} } } };
