'use client';
// 04-UI-UX §2.1 Reports worklist: six tabs, filters in the URL, barcode/registration-no. search, bulk release (reporting.report.bulk_release).
// Polls by refreshing the server component every 30 s (02-CV §2.4). Shortcuts §1.1 on page id staff.reporting.worklist.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { bulkReleaseAction, searchReportsAction } from '../server/actions';
import { REPORT_TABS, type BulkResult, type Centre, type ReportSummary, type ReportTab } from '../server/types';
import { Chip, When, errorText, formatNpr, hasPerm, newKey } from './format';
import { useShortcuts } from './useShortcuts';
import { useUrlFilters } from './useUrlFilters';

const POLL_MS = 30_000;
const TAB_LABEL: Record<ReportTab, string> = { awaiting_content: 'Awaiting content', ready_to_release: 'Ready to release', held: 'Held (dues)', render_failed: 'Render failed', released_today: 'Released today', all: 'All' };
const EMPTY: Record<ReportTab, string> = {
  awaiting_content: 'Nothing is waiting for results.', ready_to_release: 'No reports are ready to release.', held: 'No reports are held for dues.',
  render_failed: 'No failed reports. Good.', released_today: 'No reports released today yet.', all: 'No reports match these filters.',
};
const OUTCOME: Record<string, string> = { released: 'Released', blocked_due: 'Held for dues' };
const REG_NO = /^R\d{10}$/;
const FILTER_KEYS = ['centre_id', 'family', 'registered', 'review'] as const;

export interface ReportsWorklistProps { reports: readonly ReportSummary[]; tab: ReportTab; permissions: readonly string[]; centres: readonly Centre[]; nextCursor?: string | undefined;
  /** The critical alerts panel, drawn under the title (LD-353 rule 6: a failed panel is a slim banner under the title, never above it). */
  alerts?: ReactNode;
}

export function ReportsWorklist({ reports, tab, permissions, centres, nextCursor, alerts }: ReportsWorklistProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const f = useUrlFilters(FILTER_KEYS);
  const canBulk = hasPerm(permissions, 'reporting.report.bulk_release');
  const canBarcode = hasPerm(permissions, 'lab.specimen.read');
  const selectable = canBulk && (tab === 'ready_to_release' || tab === 'held');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ rows: BulkResult['results']; sent: number } | null>(null);
  const [query, setQuery] = useState('');
  const [searchMsg, setSearchMsg] = useState<string>();
  const [found, setFound] = useState<ReportSummary[]>([]);
  const key = useRef(newKey());
  const searchBox = useRef<HTMLDivElement>(null);
  const byId = new Map(reports.map((r) => [r.id, r]));
  const centreName = new Map(centres.map((c) => [c.id, c.name]));

  const goTab = (t: string) => {
    const p = new URLSearchParams(sp.toString());
    p.set('tab', t);
    p.delete('cursor');
    router.push(`/reporting?${p.toString()}`);
  };
  useEffect(() => { setSelected(new Set()); }, [tab]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') router.refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [router]);

  const askBulk = () => {
    if (selected.size === 0) toast.show({ tone: 'info', title: 'Select the reports to release first.' });
    else setConfirming(true);
  };
  useShortcuts('staff.reporting.worklist', [
    ...REPORT_TABS.map((t, i) => ({ key: `Alt+${i + 1}`, description: `Show tab: ${TAB_LABEL[t]}`, run: () => goTab(t) })),
    { key: '/', description: 'Focus the registration no. / barcode search', run: () => searchBox.current?.querySelector('input')?.focus() },
    ...(canBulk ? [{ key: 'Alt+R', description: 'Release the selected reports', run: askBulk }] : []),
  ], [canBulk, selected.size, sp.toString()]);

  const release = async () => {
    const ids = [...selected]; // report ids; bulkReleaseAction resolves version ids server-side (review C6-T31 #1)
    const r = await bulkReleaseAction(ids, key.current);
    setConfirming(false);
    if (!r.ok) { toast.show({ tone: 'danger', title: 'Could not release the reports', description: errorText(r.code) }); return; }
    key.current = newKey();
    setSelected(new Set());
    setResult({ rows: r.data.results, sent: ids.length });
    router.refresh();
  };

  const search = async () => {
    const v = query.trim().toUpperCase();
    setSearchMsg(undefined);
    setFound([]);
    if (!v) return;
    const isReg = REG_NO.test(v);
    if (!isReg && !canBarcode) { setSearchMsg('Barcode search is not available for your role — enter the registration no.'); return; }
    const r = await searchReportsAction(isReg ? { registration_no: v } : { barcode: v }); // barcode only ever travels in the POST body
    if (!r.ok) { setSearchMsg(errorText(r.code)); return; }
    if (r.data.length === 0) setSearchMsg(isReg ? 'No report found for this registration no.' : 'No report found for this barcode');
    else if (r.data.length === 1) router.push(`/reporting/reports/${r.data[0]!.id}`);
    else setFound(r.data);
  };

  // LD-353 template 1 (T0D-UILIST-1): ONE FilterBar holds the lookup, the URL filters and the status.
  // T0D-UIGUARD-1-REPORTING (LD-436 worklist mock, LD-437, LD-439): the statuses are ALSO a kit Tabs bar above the FilterBar; both go through goTab.
  // The lookup stays in component state, never in the URL (PHI, 04-UI-UX §1.2).
  const barValue = { ...f.value, tab, lookup: query };
  const onBar = (v: Readonly<Record<string, string | readonly string[] | undefined>>) => {
    const { lookup, tab: nextTab, ...rest } = v;
    setQuery(typeof lookup === 'string' ? lookup : '');
    if (typeof nextTab === 'string' && nextTab !== tab) { goTab(nextTab); return; }
    if (FILTER_KEYS.some((k) => String(rest[k] ?? '') !== String(f.value[k] ?? ''))) f.onChange(rest);
  };

  const columns: ColumnDef<ReportSummary>[] = [
    { id: 'reg', header: 'Reg no', isRowHeader: true, cell: (r) => <a className="lims-link lims-mono" href={`/reporting/reports/${r.id}`}>{r.registration_no}</a> },
    { id: 'patient', header: 'Patient', cell: (r) => r.patient_display_name },
    { id: 'centre', header: 'Centre', cell: (r) => (r.centre_id && centreName.get(r.centre_id)) || r.centre_code || '—' }, // LD-446 7b: name from the centre list, code as fallback
    { id: 'family', header: 'Family', cell: (r) => (r.family === 'laboratory' ? 'Lab' : 'Narrative') },
    { id: 'items', header: 'Items', numeric: true, cell: (r) => `${r.items_ready}/${r.items_total}` },
    { id: 'status', header: 'Status', cell: (r) => (
      <>
        <Chip status={r.display_status} label={r.display_status === 'held' && r.balance_due_paisa !== undefined ? `Held — ${formatNpr(r.balance_due_paisa)}` : undefined} />
        {r.review_flag ? <> <Chip status="held" label="Needs review" /></> : null}
      </>
    ) },
    { id: 'version', header: 'Version', cell: (r) => (r.latest_version_no ? `v${r.latest_version_no}` : '—') },
    { id: 'registered', header: 'Registered', cell: (r) => <When value={r.registered_at} /> },
    { id: 'updated', header: 'Updated', cell: (r) => <When value={r.updated_at} /> },
  ];

  const counts = result ? { ok: result.rows.filter((x) => x.outcome === 'released').length, held: result.rows.filter((x) => x.outcome === 'blocked_due').length } : null;
  // [CONV] GAP (T0D-UIGUARD-1-REPORTING): no read gives a count per status (read.server.ts lists one tab at a time), so the tabs carry no count pill (no invented numbers).
  const caption = canBarcode ? 'Find a report by registration number or barcode, or choose a status.' : 'Find a report by registration number, or choose a status.';
  return (
    <section aria-label="Reports">
      <PageHeader
        title="Reports"
        caption={caption}
        helpKey="reporting.worklist"
        actions={selectable && selected.size > 0 ? <Button variant="primary" shortcut="Alt+R" onPress={askBulk}>{`Release ${selected.size}`}</Button> : null}
      />
      {alerts}
      <Tabs aria-label="Report status" items={REPORT_TABS.map((t) => ({ id: t, label: TAB_LABEL[t] }))} selectedId={tab} onChange={(t) => { if (t !== tab) goTab(t); }}>
        <div ref={searchBox} onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).getAttribute('name') === 'lookup') { e.preventDefault(); void search(); } }}>
          <FilterBar
            filters={[
              { id: 'lookup', label: canBarcode ? 'Registration no. or barcode' : 'Registration no.', kind: 'text', maxLength: 20 },
              { id: 'tab', label: 'Status', kind: 'select', options: REPORT_TABS.map((t) => ({ value: t, label: TAB_LABEL[t] })) },
              { id: 'centre_id', label: 'Centre', kind: 'select', options: centres.map((c) => ({ value: c.id, label: c.name })) },
              { id: 'family', label: 'Family', kind: 'select', options: [{ value: 'laboratory', label: 'Lab' }, { value: 'narrative', label: 'Narrative' }] },
              { id: 'registered', label: 'Registered', kind: 'date_range' },
              { id: 'review', label: 'Review flag', kind: 'select', options: [{ value: 'yes', label: 'Needs review' }, { value: 'no', label: 'No review flag' }] },
            ]}
            value={barValue} onChange={onBar} onReset={() => { setQuery(''); f.onReset(); }} onSearch={() => void search()}
            resetLabel="Clear filters"
          />
        </div>
        {searchMsg ? <p role="status" className="lims-description">{searchMsg}</p> : null}
        {found.length > 0 ? (
          <Card title="Matching reports">
            <DataTable
              caption="Matching reports" density="compact" rows={found} getRowId={(r) => r.id} emptyState={{ title: 'No report found.' }}
              columns={[
                { id: 'reg', header: 'Reg no', isRowHeader: true, cell: (r) => <a className="lims-link lims-mono" href={`/reporting/reports/${r.id}`}>{r.registration_no}</a> },
                { id: 'patient', header: 'Patient', cell: (r) => r.patient_display_name },
              ]}
            />
          </Card>
        ) : null}
        {counts ? <p role="status">{`${counts.ok} released · ${counts.held} held for dues · ${result!.sent - counts.ok - counts.held} not released`}</p> : null}
        {result ? (
          <DataTable
            caption="Bulk release result" density="compact"
            rows={result.rows} getRowId={(x) => x.id}
            columns={[
              { id: 'r', header: 'Report', isRowHeader: true, cell: (x) => byId.get(x.id)?.registration_no ?? '—' },
              { id: 'o', header: 'Outcome', cell: (x) => OUTCOME[x.outcome] ?? errorText(x.outcome) },
            ]}
            emptyState={{ title: 'Nothing was released.' }}
          />
        ) : null}
        <DataTable
          caption={`Reports: ${TAB_LABEL[tab]}`} density="compact"
          columns={columns} rows={reports} getRowId={(r) => r.id} emptyState={{ title: EMPTY[tab] }}
          {...(selectable ? { selection: { mode: 'multiple' as const, selectedIds: selected, onChange: setSelected } } : {})}
        />
        {nextCursor ? <p><a className="lims-link" href={`/reporting?${new URLSearchParams({ ...Object.fromEntries(sp.entries()), tab, cursor: nextCursor }).toString()}`}>Next page</a></p> : null}
      </Tabs>
      <ConfirmDialog
        title={`Release ${selected.size} reports?`}
        body="Reports with dues will stay held unless an override exists. Messages are sent to patients who agreed to them."
        confirmLabel={`Release ${selected.size}`}
        isOpen={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={release}
      />
    </section>
  );
}
