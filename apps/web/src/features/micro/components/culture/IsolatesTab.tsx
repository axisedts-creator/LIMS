'use client';
// 04-UI-UX §3.3 tab "Isolates & AST", isolate half (the AST grid on the right is T-21): isolate list as a single-selection DataTable (Isolate no., Organism, Source, Quantity,
// Reportable, Status) with the row menu Identify, Edit description, Choose AST panel, Withdraw. LD-140 (2026-11-13): kit components only; status = tone + icon + word.
// Two isolates of the same organism stay two rows; the numbers are the server's isolate_seq (AC-05.5). Organism names are text nodes (REQ-SEC-088).
import type { ReactNode } from 'react';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Stack } from '@lims/ui/components/Stack';
import { Chip, type Tone } from '../common';
import type { CultureDetailDto, IsolateDto } from '../../server/types';

const STATUS: Record<IsolateDto['status'], { label: string; tone: Tone }> = {
  pending_id: { label: 'Not identified', tone: 'neutral' },
  identified: { label: 'Identified', tone: 'success' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};
const SOURCE: Record<string, string> = { manual: 'Manual', instrument: 'Instrument' };

export type IsolateAction = 'identify' | 'describe' | 'panel' | 'withdraw';
const LABEL: Record<IsolateAction, string> = { identify: 'Identify', describe: 'Edit description', panel: 'Choose AST panel', withdraw: 'Withdraw' };

/** Row menu by status; none for a withdrawn isolate. "Choose AST panel" needs an identified organism. */
export const actionsFor = (i: IsolateDto): IsolateAction[] => (i.status === 'withdrawn' ? [] : i.status === 'pending_id' ? ['identify', 'describe', 'withdraw'] : ['identify', 'describe', 'panel', 'withdraw']);

export function IsolatesTab({ culture, canWork, selectedId, onSelect, onAction, pane }: { culture: CultureDetailDto; canWork: boolean; selectedId: string | undefined; onSelect: (id: string | undefined) => void; onAction: (i: IsolateDto, a: IsolateAction) => void; pane?: ReactNode }) {
  const rows = [...culture.isolates].sort((a, b) => a.isolate_seq - b.isolate_seq);
  const columns: ColumnDef<IsolateDto>[] = [
    // [CONV] the trailing space keeps the number apart from the organism name when the row's text is read as one string (textContent, copy, text search).
    { id: 'seq', header: 'Isolate no.', isRowHeader: true, align: 'end', cell: (i) => `${i.isolate_seq} ` },
    { id: 'organism', header: 'Organism', cell: (i) => i.organism_display ?? 'Not identified' },
    { id: 'source', header: 'Source', cell: (i) => (i.organism_source ? SOURCE[i.organism_source] ?? i.organism_source : '—') },
    { id: 'quantity', header: 'Quantity', cell: (i) => i.quantity_text ?? '—' },
    { id: 'reportable', header: 'Reportable', cell: (i) => (i.is_reportable ? 'Yes' : 'No') },
    { id: 'status', header: 'Status', cell: (i) => <Chip tone={STATUS[i.status].tone} label={STATUS[i.status].label} /> },
  ];
  // [CONV] The AST pane (T-21) sits below the list, not beside it: the grid has seven columns and needs the full width (04-UI-UX §3.3 draws it on the right).
  return (
    <Stack gap={3}>
    <DataTable<IsolateDto>
      caption="Isolates"
      density="compact"
      columns={columns}
      rows={rows}
      getRowId={(i) => i.id}
      emptyState={{ title: 'No isolates recorded.' }}
      selection={{ mode: 'single', selectedIds: new Set(selectedId ? [selectedId] : []), onChange: (ids) => onSelect([...ids][0]) }}
      {...(canWork
        ? {
            rowActions: (i: IsolateDto) => actionsFor(i).map((a) => ({ id: a, label: LABEL[a], ...(a === 'withdraw' ? { isDanger: true } : {}) })),
            onRowActionMenu: (i: IsolateDto, id: string) => {
              if ((actionsFor(i) as string[]).includes(id)) onAction(i, id as IsolateAction);
            },
          }
        : {})}
    />
    {pane}
    </Stack>
  );
}
