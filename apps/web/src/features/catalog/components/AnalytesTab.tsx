'use client';
// SCR-06 Analytes tab (04-UI-UX §4): table in sort_order, row open → ?analyte=<id>, Alt+↑/↓ reorders via PATCH sort_order (#31).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { useToast } from '@lims/ui/components/Toast';
import { updateAnalyteAction } from '../server/actions';
import type { AnalyteRow } from '../server/types';
import { FailBanner, PERM, type Fail } from './shared';

const COLUMNS = ['Order', 'Sub-heading', 'Code', 'Name', 'Result type', 'Unit', 'Decimals', 'Method', 'Formula', 'Range set', 'Current version', 'Draft'] as const;
const RESULT_LABEL: Record<string, string> = { numeric: 'Numeric', ordinal: 'Ordinal', coded: 'Coded', text: 'Text', narrative: 'Narrative', attachment: 'Attachment' };
const HAS_RANGES = new Set(['numeric', 'ordinal', 'coded']);

export function AnalytesTab({ testId, analytes, permissions }: { testId: string; analytes: readonly AnalyteRow[]; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [fail, setFail] = useState<Fail>();
  const canManage = permissions.includes(PERM.manage);
  const rows = [...analytes].sort((a, b) => a.sort_order - b.sort_order);
  const base = `/catalog/tests/${testId}`;

  // ponytail: sort_order is set between the new neighbours (midpoint), ties possible when the gap is 0 — renumber server-side if that bites.
  const move = async (i: number, dir: 1 | -1) => {
    const row = rows[i]!;
    const over = rows[i + dir];
    if (!canManage || !over) return;
    const beyond = rows[i + 2 * dir];
    const target = beyond ? Math.floor((over.sort_order + beyond.sort_order) / 2) : over.sort_order + dir * 10;
    const sort_order = Math.min(9999, Math.max(0, target === over.sort_order ? over.sort_order + dir : target));
    const r = await updateAnalyteAction(row.id, row.version, { sort_order });
    if (r.ok) {
      setFail(undefined);
      toast.show({ tone: 'success', title: 'Order saved.' });
      router.refresh();
    } else setFail(r);
  };

  return (
    <div className="lims-stack catalog-gap-3">
      {fail ? <FailBanner fail={fail} /> : null}
      {canManage ? <div><Button variant="primary" onPress={() => router.push(`${base}?analyte=new`)}>Add analyte</Button></div> : null}
      {/* T0D-UIX-2 (LD-442): the kit DataTable; Enter opens the row (onRowAction), Alt+ArrowUp / Alt+ArrowDown on a row reorders it */}
      <div
        {...(canManage ? { 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' } : {})}
        onKeyDownCapture={(e) => {
          if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
          const id = (e.target as HTMLElement).closest?.('[data-row-id]')?.getAttribute('data-row-id');
          const i = rows.findIndex((r) => r.id === id);
          if (i < 0) return;
          e.preventDefault();
          e.stopPropagation();
          void move(i, e.key === 'ArrowDown' ? 1 : -1);
        }}
      >
        <DataTable<AnalyteRow>
          caption="Analytes"
          density="regular"
          rows={rows}
          getRowId={(a) => a.id}
          onRowAction={(a) => router.push(`${base}?analyte=${a.id}`)}
          emptyState={{ title: 'This test has no analytes yet.' }}
          columns={[
            { id: 'order', header: COLUMNS[0], numeric: true, cell: (a) => a.sort_order },
            { id: 'subheading', header: COLUMNS[1], cell: (a) => a.report_subheading ?? '' },
            { id: 'code', header: COLUMNS[2], isRowHeader: true, cell: (a) => a.code },
            { id: 'name', header: COLUMNS[3], cell: (a) => a.name },
            { id: 'result_type', header: COLUMNS[4], cell: (a) => RESULT_LABEL[a.result_type] ?? a.result_type },
            { id: 'unit', header: COLUMNS[5], cell: (a) => a.unit_code ?? '' },
            { id: 'decimals', header: COLUMNS[6], numeric: true, cell: (a) => a.decimals ?? '' },
            { id: 'method', header: COLUMNS[7], cell: (a) => a.method_name ?? '' },
            { id: 'formula', header: COLUMNS[8], cell: (a) => (a.formula_expression ? <><span role="img" aria-label="Formula">ƒ</span> <code>{a.formula_expression}</code></> : null) },
            { id: 'range_set', header: COLUMNS[9], cell: (a) => (a.range_set_version != null ? `v${a.range_set_version}` : HAS_RANGES.has(a.result_type) ? <Badge tone="warning">None</Badge> : '—') },
            { id: 'version', header: COLUMNS[10], cell: (a) => (a.current_version_no != null ? `v${a.current_version_no}` : '') },
            { id: 'draft', header: COLUMNS[11], cell: (a) => (a.has_draft ? <Badge tone="info">Draft</Badge> : null) },
            { id: 'actions', header: 'Actions', cell: (a) => <Button size="sm" onPress={() => router.push(`${base}?analyte=${a.id}`)}>Open</Button> },
          ]}
        />
      </div>
    </div>
  );
}
