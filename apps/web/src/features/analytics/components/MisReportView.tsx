'use client';
// T0D-MISREPORTS-1 (LD-321, LD-342 / A39, LD-353 LIST template): one frame for the ten MIS catalogue reports and Bill of the Day. Props are the plain JSON
// view model of server/mis-page.tsx; filter state lives in the URL (a change = router.push, the server page re-reads). No fetch here: the CSV is built by the
// server export (createAnalyticsExport via ExportDialog), the schedule by the existing editor. Ids never reach the screen (07-SECURITY).
// OPEN CR (notes/T0D-MISREPORTS-1-cr-needed.md): no read operation exists for the definitions, so the body is the header row plus an empty state.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FilterBar, type FilterDef } from '@lims/ui/components/FilterBar';
import { Menu } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import { searchReferrersAction } from '../server/actions';
import type { MisColumn } from '../report-codes';
import { ExportDialog } from './ExportDialog';

type Opt = { value: string; label: string };
export interface MisQuery { business_date_from: string; business_date_to: string; centre_id?: string[]; filters?: Record<string, unknown> }
export type MisVM =
  | { state: 'mfa' | 'disabled' }
  | {
      state: 'open'; code: string; title: string; basePath: string; oneDay: boolean; params: readonly string[]; columns: readonly MisColumn[]; query: MisQuery;
      centres: Opt[]; departments: Opt[]; canExport: boolean; canSchedule: boolean; pdfEnabled: boolean;
    };

const NUMERIC = new Set(['integer', 'integer_paisa', 'basis_points']);
const ID_FILTERS: Record<string, string> = { party_id: 'analytics.mis.filter.party', representative_id: 'analytics.mis.filter.representative', collector_id: 'analytics.mis.filter.collector' };
// LD-353: controls hidden and rows kept whole on paper; one page for Bill of the Day (compact table, no shell chrome)
const PRINT_CSS = '@media print { .mis-noprint, nav, header button { display: none !important; } .mis-sheet tr { break-inside: avoid; } .mis-sheet { font-size: 10pt; } }';

/** URL search of a query (the server page whitelists it again). */
function toSearch(q: MisQuery) {
  const s = new URLSearchParams({ business_date_from: q.business_date_from, business_date_to: q.business_date_to });
  if (q.centre_id?.length) s.set('centre_id', q.centre_id.join(','));
  for (const [k, v] of Object.entries(q.filters ?? {})) s.set(k, Array.isArray(v) ? v.join(',') : String(v));
  return s;
}
const listOf = (q: MisQuery, k: string) => ((q.filters?.[k] as string[] | undefined) ?? []);

type Ref = { id: string; label: string; isActive: boolean };
type Row = { id: string };

export function MisReportView({ vm }: { vm: MisVM }) {
  if (vm.state !== 'open') {
    // A39: a closed gate shows no report name, no column and no amount word
    return (
      <>
        <PageHeader title={t('analytics.nav.reports')} helpKey="analytics.reports.mis" />
        {vm.state === 'mfa'
          ? <Banner tone="warning" title={t('analytics.mis.mfa')} action={{ label: t('analytics.mis.verify'), onPress: () => window.location.reload() }} />
          : <EmptyState title={t('analytics.mis.disabled')} />}
      </>
    );
  }
  return <OpenView vm={vm} />;
}

function OpenView({ vm }: { vm: Extract<MisVM, { state: 'open' }> }) {
  const router = useRouter();
  const [format, setFormat] = useState<'xlsx' | 'csv' | 'pdf'>();
  const q = vm.query;
  const has = (p: string) => vm.params.includes(p);

  const go = (patch: Record<string, string | undefined>) => {
    const s = toSearch(q);
    for (const [k, v] of Object.entries(patch)) (v === undefined || v === '' ? s.delete(k) : s.set(k, v));
    router.push(`${vm.basePath}?${s.toString()}`);
  };

  const filters: FilterDef[] = [
    { id: 'centre_id', label: t('analytics.mis.filter.centre'), kind: 'select', multiple: true, options: vm.centres },
    ...(has('department_id') ? [{ id: 'department_id', label: t('analytics.mis.filter.department'), kind: 'select' as const, multiple: true, options: vm.departments }] : []),
    ...(has('visit_type') ? [{ id: 'visit_type', label: t('analytics.mis.filter.visit_type'), kind: 'select' as const, options: [{ value: 'all', label: t('analytics.mis.all') }, { value: 'opd', label: 'OPD' }, { value: 'ipd', label: 'IPD' }] }] : []),
  ];
  const fv = { centre_id: q.centre_id ?? [], department_id: listOf(q, 'department_id'), visit_type: (q.filters?.['visit_type'] as string | undefined) ?? 'all' };

  const columns: ColumnDef<Row>[] = vm.columns.map((c, i) => ({ id: c.name, header: c.title, cell: () => '—', isRowHeader: i === 0,...(NUMERIC.has(c.type) ? { align: 'end' as const, numeric: true } : {}) }));
  const empty = { title: t('analytics.mis.empty'), body: t('analytics.mis.empty_hint') };
  const title = vm.oneDay ? t('billing.botd.title') : vm.title;
  const centres = (q.centre_id ?? []).map((id) => vm.centres.find((c) => c.value === id)?.label).filter((x): x is string => !!x);

  return (
    <div className="mis-sheet">
      <style>{PRINT_CSS}</style>
      <PageHeader
        title={title} helpKey="analytics.reports.mis"
        actions={
          <span className="mis-noprint">
            <Button variant="secondary" onPress={() => window.print()}>{t('analytics.mis.print')}</Button>
            {vm.canExport ? (
              <Menu
                trigger={<Button variant="secondary">{t('analytics.mis.export')}</Button>}
                items={[{ id: 'csv', label: 'CSV (.csv)' }, { id: 'xlsx', label: 'Excel (.xlsx)' }, { id: 'pdf', label: 'PDF', isDisabled: !vm.pdfEnabled }]}
                onAction={(id) => setFormat(id as 'xlsx' | 'csv' | 'pdf')}
              />
            ) : null}
            {vm.canSchedule ? <a href="/analytics/schedules/new">{t('analytics.mis.schedule')}</a> : null}
          </span>
        }
      />
      <p>{vm.oneDay ? q.business_date_from : `${q.business_date_from} – ${q.business_date_to}`}</p>
      <div className="mis-noprint lims-filter-bar">
        {vm.oneDay ? (
          <label className="lims-field">
            <span className="lims-label">{t('billing.botd.day')}</span>
            <input className="lims-input" type="date" value={q.business_date_from} onChange={(e) => e.target.value && go({ business_date_from: e.target.value, business_date_to: e.target.value })} />
          </label>
        ) : (
          <>
            <label className="lims-field">
              <span className="lims-label">{t('analytics.mis.from')}</span>
              <input className="lims-input" type="date" value={q.business_date_from} max={q.business_date_to} onChange={(e) => e.target.value && go({ business_date_from: e.target.value })} />
            </label>
            <label className="lims-field">
              <span className="lims-label">{t('analytics.mis.to')}</span>
              <input className="lims-input" type="date" value={q.business_date_to} min={q.business_date_from} onChange={(e) => e.target.value && go({ business_date_to: e.target.value })} />
            </label>
          </>
        )}
        <FilterBar
          filters={filters} value={fv} onReset={() => router.push(vm.basePath)}
          onChange={(v) => {
            const j = (k: string) => { const x = v[k]; return Array.isArray(x) ? x.join(',') || undefined : undefined; };
            const vt = typeof v['visit_type'] === 'string' && v['visit_type'] !== 'all' ? (v['visit_type'] as string) : undefined;
            go({ centre_id: j('centre_id'), ...(has('department_id') ? { department_id: j('department_id') } : {}), ...(has('visit_type') ? { visit_type: vt } : {}) });
          }}
        />
        {Object.entries(ID_FILTERS).filter(([p]) => has(p)).map(([p, key]) => {
          const n = listOf(q, p).length;
          // ponytail: no MIS party / representative / collector search exists in the analytics contract; the choice arrives in the URL (links from those
          // screens). Add a search picker when the CR read lands with a lookup.
          return (
            <div key={p} className="lims-field">
              <span className="lims-label" id={`mis-${p}`}>{t(key)}</span>
              <span aria-labelledby={`mis-${p}`}>{n ? `${n} ${t('analytics.mis.selected')}` : t('analytics.mis.all')}</span>
              {n ? <Button variant="ghost" onPress={() => go({ [p]: undefined })}>{t('analytics.mis.clear')}</Button> : null}
            </div>
          );
        })}
        {has('referrer_id') ? (
          <div className="lims-field">
            <Combobox<Ref>
              label={t('analytics.mis.filter.referrer')} name="referrer_id" minChars={2} debounceMs={150}
              loadOptions={(text) => searchReferrersAction(text)}
              getKey={(r) => r.id} renderValue={(r) => r.label} renderOption={(r) => (r.isActive ? r.label : `${r.label} (inactive)`)}
              onChange={(r) => { const cur = listOf(q, 'referrer_id'); if (r && !cur.includes(r.id) && cur.length < 20) go({ referrer_id: [...cur, r.id].join(',') }); }}
            />
            {listOf(q, 'referrer_id').length ? <Button variant="ghost" onPress={() => go({ referrer_id: undefined })}>{`${t('analytics.mis.clear')} (${listOf(q, 'referrer_id').length})`}</Button> : null}
          </div>
        ) : null}
        {has('min_repeat_count') ? (
          <label className="lims-field">
            <span className="lims-label">{t('analytics.mis.filter.min_repeat')}</span>
            <input
              className="lims-input" type="number" min={2} max={100} step={1} defaultValue={(q.filters?.['min_repeat_count'] as number | undefined) ?? ''}
              onBlur={(e) => { const v = e.target.value; if (v !== String(q.filters?.['min_repeat_count'] ?? '')) go({ min_repeat_count: v || undefined }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          </label>
        ) : null}
      </div>
      <DataTable<Row> columns={columns} rows={[]} getRowId={(r) => r.id} density="compact" stickyHeader caption={title} emptyState={empty} />
      {vm.oneDay ? (
        <DataTable<Row>
          caption={t('billing.botd.by_mode')} density="compact" rows={[]} getRowId={(r) => r.id} emptyState={{ title: t('billing.botd.by_mode_empty') }}
          columns={[{ id: 'mode', header: t('billing.botd.mode'), cell: () => '—', isRowHeader: true }, { id: 'amount', header: t('billing.botd.amount'), cell: () => '—', align: 'end', numeric: true }]}
        />
      ) : null}
      {format ? (
        <ExportDialog
          isOpen onClose={() => setFormat(undefined)} initialFormat={format} reportCode={vm.code} pdfEnabled={vm.pdfEnabled}
          params={{ ...q }}
          summary={{ report: title, periodAd: `${q.business_date_from} – ${q.business_date_to}`, periodBs: '—', centres }}
        />
      ) : null}
    </div>
  );
}
