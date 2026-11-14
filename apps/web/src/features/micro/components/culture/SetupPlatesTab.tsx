'use client';
// 04-UI-UX §3.1 tab "Setup & plates": plates DataTable (No., Medium, Incubation, Planted, Parent plate, From isolate, Status) with the row action "Discard plate".
// LD-140 (2026-11-13): kit components only; status = tone + icon + word. Medium shows its display name (loaded lazily; a retired medium still shows its name).
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Chip, When } from '../common';
import { displayOf } from '../../forms/format';
import { useCodes } from '../../forms/useCodes';
import type { CultureDetailDto, PlateDto } from '../../server/types';

export function SetupPlatesTab({ culture, canDiscard, onDiscard }: { culture: CultureDetailDto; canDiscard: boolean; onDiscard: (p: PlateDto) => void }) {
  const media = useCodes('media', culture.plates.length > 0);
  const plates = [...culture.plates].sort((a, b) => a.plate_no - b.plate_no);
  const noOf = (id: string | undefined) => (id ? culture.plates.find((p) => p.id === id)?.plate_no : undefined);
  const seqOf = (id: string | undefined) => (id ? culture.isolates.find((i) => i.id === id)?.isolate_seq : undefined);
  const columns: ColumnDef<PlateDto>[] = [
    { id: 'no', header: 'No.', isRowHeader: true, align: 'end', cell: (p) => String(p.plate_no) },
    { id: 'medium', header: 'Medium', cell: (p) => displayOf(media.rows, p.media_code) },
    { id: 'incubation', header: 'Incubation', cell: (p) => p.incubation_text ?? '—' },
    { id: 'planted', header: 'Planted', cell: (p) => <When value={p.planted_at} time /> },
    { id: 'parent', header: 'Parent plate', cell: (p) => noOf(p.parent_plate_id) ?? '—' },
    { id: 'isolate', header: 'From isolate', cell: (p) => seqOf(p.source_isolate_id) ?? '—' },
    { id: 'status', header: 'Status', cell: (p) => <Chip tone={p.status === 'active' ? 'success' : 'neutral'} label={p.status === 'active' ? 'Active' : 'Discarded'} /> },
  ];
  const canDiscardOne = (p: PlateDto) => canDiscard && p.status === 'active';
  return (
    <DataTable<PlateDto>
      caption="Plates"
      density="compact"
      columns={columns}
      rows={plates}
      getRowId={(p) => p.id}
      emptyState={{ title: culture.status === 'awaiting_setup' ? 'This culture has not been set up yet. No plates.' : 'No plates.' }}
      {...(canDiscard ? { rowActions: (p: PlateDto) => (canDiscardOne(p) ? [{ id: 'discard', label: 'Discard plate', isDanger: true }] : []), onRowActionMenu: (p: PlateDto, id: string) => { if (id === 'discard' && canDiscardOne(p)) onDiscard(p); } } : {})}
    />
  );
}
