'use client';
// SCR-06 Analytes tab (04-UI-UX §4): table in sort_order, row open → ?analyte=<id>, Alt+↑/↓ reorders via PATCH sort_order (#31).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
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

  if (rows.length === 0) {
    return (
      <div className="lims-stack catalog-gap-3">
<p>This test has no analytes yet.</p>
        {canManage ? <div><Button variant="primary" onPress={() => router.push(`${base}?analyte=new`)}>Add analyte</Button></div> : null}
      </div>
    );
  }

  return (
    <div className="lims-stack catalog-gap-3">
      {fail ? <FailBanner fail={fail} /> : null}
      {canManage ? <div><Button variant="primary" onPress={() => router.push(`${base}?analyte=new`)}>Add analyte</Button></div> : null}
      <table className="lims-table" aria-label="Analytes">
        <thead>
          <tr>
            {COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}
            <th scope="col"><VisuallyHidden>Actions</VisuallyHidden></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a, i) => (
            <tr
              key={a.id}
              tabIndex={0}
              aria-keyshortcuts={canManage ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  void move(i, e.key === 'ArrowDown' ? 1 : -1);
                } else if (e.key === 'Enter') router.push(`${base}?analyte=${a.id}`);
              }}
            >
              <td>{a.sort_order}</td>
              <td>{a.report_subheading ?? ''}</td>
              <td>{a.code}</td>
              <td>{a.name}</td>
              <td>{RESULT_LABEL[a.result_type] ?? a.result_type}</td>
              <td>{a.unit_code ?? ''}</td>
              <td>{a.decimals ?? ''}</td>
              <td>{a.method_name ?? ''}</td>
              <td>
                {a.formula_expression ? (
                  <>
                    <span role="img" aria-label="Formula">ƒ</span> <code>{a.formula_expression}</code>
                  </>
                ) : null}
              </td>
              <td>
                {a.range_set_version != null ? `v${a.range_set_version}` : HAS_RANGES.has(a.result_type) ? <Badge tone="warning">None</Badge> : '—'}
              </td>
              <td>{a.current_version_no != null ? `v${a.current_version_no}` : ''}</td>
              <td>{a.has_draft ? <Badge tone="info">Draft</Badge> : null}</td>
              <td><Button size="sm" onPress={() => router.push(`${base}?analyte=${a.id}`)}>Open</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
