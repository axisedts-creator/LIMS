'use client';
// 04-UI-UX §6.1 Breakpoint tables list (AC-12.1, AC-12.3, AC-12.5). LD-140: kit components only; "Import table" is the page's one primary button.
// Titles and every other server text render as text nodes (REQ-SEC-088, S-13). Import affordance is a UI hint; the API enforces micro.breakpoint.manage.
import { useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { BreakpointSetDto } from '../../server/types';
import { PERM, When } from '../common';
import { ImportDialog } from './ImportDialog';
import { BreakpointStatusChip } from './status';

const LICENCE = 'LIMS does not include CLSI or EUCAST breakpoints. Import only tables your laboratory is licensed to use.';

const COLUMNS: readonly ColumnDef<BreakpointSetDto>[] = [
  { id: 'title', header: 'Title', isRowHeader: true, cell: (s) => <a className="lims-link" href={`/micro/breakpoint-sets/${s.id}`}>{s.title}</a> },
  { id: 'standard', header: 'Standard', cell: (s) => s.standard },
  { id: 'version', header: 'Version', cell: (s) => s.standard_version },
  { id: 'status', header: 'Status', cell: (s) => <BreakpointStatusChip status={s.status} /> },
  { id: 'from', header: 'Effective from', cell: (s) => <When value={s.effective_from} /> },
  { id: 'to', header: 'Effective to', cell: (s) => <When value={s.effective_to} /> },
  { id: 'rows', header: 'Rows', align: 'end', cell: (s) => String(s.row_count) },
  { id: 'errors', header: 'Errors', align: 'end', cell: (s) => String(s.error_count) },
  { id: 'by', header: 'Imported by', cell: (s) => s.imported_by_display },
  { id: 'at', header: 'Imported at', cell: (s) => <When value={s.created_at} time /> },
];

export function BreakpointSetsScreen({ sets, permissions }: { sets: readonly BreakpointSetDto[]; permissions: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const canImport = permissions.includes(PERM.breakpoint);
  return (
    <section aria-label="Breakpoint tables">
      <PageHeader
        title="Breakpoint tables"
        helpKey="micro.breakpoint_sets"
        breadcrumbs={[{ label: 'Microbiology' }, { label: 'Breakpoint tables' }]}
        actions={canImport ? <Button variant="primary" onPress={() => setOpen(true)}>Import table</Button> : null}
      />
      <Banner tone="info" title={LICENCE} />
      <DataTable<BreakpointSetDto> caption="Breakpoint tables" columns={COLUMNS} rows={sets} getRowId={(s) => s.id} emptyState={{ title: 'No breakpoint tables imported. Categories are entered manually.' }} />
      {open ? <ImportDialog onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
