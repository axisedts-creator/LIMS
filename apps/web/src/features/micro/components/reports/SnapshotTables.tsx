'use client';
// Read-only isolate and AST tables shared by the compose drawer (preview of what the server will snapshot) and the version viewer (the stored snapshot). 04-UI-UX §3.4.
// LD-140 (2026-11-13): kit DataTable only; a reportable AST row without a category shows the word "Category missing" with icon and tone, never colour alone.
// All text comes from the API and is rendered as text nodes (REQ-SEC-088).
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import type { AstMethod } from '../../server/types';
import { Chip } from '../common';
import { withUnit } from './snapshot';

export interface IsolateRow { seq: number; organism: string; growth?: string | undefined }
export interface AstRow { isolate_seq: number; antibiotic_code: string; antibiotic: string; method: AstMethod; raw?: string | undefined; category?: string | undefined; standard?: string | undefined; version?: string | undefined }

const ISOLATE_COLS: ColumnDef<IsolateRow>[] = [
  { id: 'seq', header: 'Isolate', cell: (r) => r.seq, width: 80 },
  { id: 'organism', header: 'Organism', isRowHeader: true, cell: (r) => r.organism },
  { id: 'growth', header: 'Growth', cell: (r) => r.growth ?? '—' },
];
const METHOD_LABEL: Record<AstMethod, string> = { mic: 'MIC', zone_diameter: 'Zone diameter', other: 'Other' };
const AST_COLS: ColumnDef<AstRow>[] = [
  { id: 'isolate', header: 'Isolate', cell: (r) => r.isolate_seq, width: 80 },
  { id: 'antibiotic', header: 'Antibiotic', isRowHeader: true, cell: (r) => r.antibiotic },
  { id: 'method', header: 'Method', cell: (r) => METHOD_LABEL[r.method] ?? r.method },
  { id: 'raw', header: 'Raw value', cell: (r) => `${withUnit(r.raw, r.method)} ` }, // trailing space: cell texts stay separate words when read as one string
  { id: 'category', header: 'Category', cell: (r) => (r.category ? r.category : <Chip tone="warning" label="Category missing" />) },
  { id: 'standard', header: 'Standard', cell: (r) => [r.standard, r.version].filter(Boolean).join(' ') || '—' },
];

export function IsolatesTable({ rows, caption = 'Included isolates' }: { rows: readonly IsolateRow[]; caption?: string }) {
  return <DataTable<IsolateRow> caption={caption} columns={ISOLATE_COLS} rows={rows} getRowId={(r) => String(r.seq)} density="compact" emptyState={{ title: 'No isolates are included.' }} />;
}

export function AstTable({ rows, caption = 'Included AST results' }: { rows: readonly AstRow[]; caption?: string }) {
  return <DataTable<AstRow> caption={caption} columns={AST_COLS} rows={rows} getRowId={(r) => `${r.isolate_seq}:${r.antibiotic_code}`} density="compact" emptyState={{ title: 'No AST results are included.' }} />;
}
