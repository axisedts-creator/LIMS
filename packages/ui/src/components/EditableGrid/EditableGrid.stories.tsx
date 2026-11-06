import { useState } from 'react';
import { EditableGrid, type EditableGridRow } from './EditableGrid';

export default { title: 'Data/EditableGrid', component: EditableGrid };

const columns = [
  { id: 'code', header: 'Code', maxLength: 16 },
  { id: 'display', header: 'Display', maxLength: 40 },
  { id: 'order', header: 'Order', isReadOnly: true },
];
export const Default = {
  render: () => {
    const [rows, setRows] = useState<EditableGridRow[]>([
      { id: 'r1', values: { code: 'POS', display: 'Positive', order: '1' }, status: 'saved' },
      { id: 'r2', values: { code: 'NEG', display: 'Negative', order: '2' }, status: 'error', statusText: 'Code already exists', errors: { code: 'Code already exists' } },
    ]);
    return (
      <EditableGrid
        label="Values"
        columns={columns}
        rows={rows}
        onCellChange={(rid, cid, v) => setRows((rs) => rs.map((r) => (r.id === rid ? { ...r, values: { ...r.values, [cid]: v }, status: 'unsaved' } : r)))}
      />
    );
  },
};
