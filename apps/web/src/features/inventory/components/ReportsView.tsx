'use client';
// S17 Reports (04-UI-UX §3 S17; AC-21.1-.9; TRD #92). Help: inventory.help.consumption_model.
// LD-140 (2026-11-13): kit Tabs, DateRangePicker (366 days), DateTimePicker; ONE primary button per page (this page has none: Export CSV is secondary).
// Gating: the page needs inventory.item.read; the "Cost per test" tab needs inventory.cost.read; "Export CSV" needs inventory.report.export (cost_per_test also inventory.cost.read);
// the "Reconciliation" tab is shown only when GET /v1/identity/me reports centre_scope.all (the page resolves it server-side and fails closed).
// A tab or filter change asks the API again through a server action (the token stays on the server) and updates the URL without a page reload.
import { useRef, useState, type ComponentProps } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Combobox } from '@lims/ui/components/Combobox';
import type { IsoDate } from '@lims/ui/components/DatePicker';
import { DateRangePicker } from '@lims/ui/components/DateRangePicker';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { Tabs } from '@lims/ui/components/Tabs';
import { getReportAction, searchItemsAction } from '../server/actions';
import { DATED, EXPORT_ERROR_TITLE, MAX_DAYS, toPageQuery, toReportQuery, type ReportFilters } from '../reportQuery';
import type { ActionResult, Instrument, ItemSummary, ReportCode, ReportResult, Store, TestRef } from '../server/types';
import { ReportBody } from './ReportBody';
import { CONSUMPTION_HELP } from './RulesView';
import { Pick, ProblemBanner, type Failure } from './shared';

type IsoUtc = NonNullable<ComponentProps<typeof DateTimePicker>['value']>;
const ALL = '__all';
export const TAB_LABEL: Record<ReportCode, string> = {
  daily_consumption: 'Daily consumption',
  analyser_consumption: 'Analyser-wise',
  cost_per_test: 'Cost per test',
  wastage: 'Wastage',
  expiry: 'Expiry',
  stock_valuation: 'Valuation',
  consumption_reconciliation: 'Reconciliation',
};
const BY_ANALYSER_AND_TEST: ReadonlySet<ReportCode> = new Set<ReportCode>(['daily_consumption', 'analyser_consumption', 'cost_per_test', 'consumption_reconciliation']);

export interface ReportsViewProps {
  /** Tabs this caller may see, in spec order. */
  tabs: readonly ReportCode[];
  code: ReportCode;
  filters: ReportFilters;
  result: ActionResult<ReportResult>;
  /** Server time, so "As of" defaults to now without a hydration mismatch. */
  nowIso: string;
  stores: readonly Store[];
  instruments: readonly Instrument[];
  tests: readonly TestRef[];
  canCost: boolean;
  canExport: boolean;
  /** Contract error code (#93) the export route redirected back with; the page has already dropped anything that is not one. */
  exportError?: string;
  /** The item behind ?item=, resolved by the page so the Item combobox shows (and can clear) the active filter after a remount. */
  selectedItem?: ItemSummary;
}

export function ReportsView(p: ReportsViewProps) {
  const path = usePathname();
  const seq = useRef(0);
  const [code, setCode] = useState(p.code);
  const [f, setF] = useState(p.filters);
  const [res, setRes] = useState(p.result);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const [item, setItem] = useState<ItemSummary | undefined>(p.selectedItem);
  const [exportProblem, setExportProblem] = useState<Failure | undefined>(
    p.exportError ? { ok: false, status: 0, code: p.exportError, title: EXPORT_ERROR_TITLE[p.exportError] ?? 'The export could not be created' } : undefined,
  );

  const load = async (c: ReportCode, nf: ReportFilters) => {
    const n = ++seq.current;
    setExportProblem(undefined);
    setCode(c);
    setF(nf);
    setLoading(true);
    const r = await getReportAction(c, toReportQuery(c, nf));
    if (n !== seq.current) return; // a newer request superseded this one
    setRes(r);
    setLoading(false);
    window.history.replaceState(null, '', `${path}?${toPageQuery(c, nf)}`);
  };
  const set = (k: keyof ReportFilters) => (v: string | undefined) => void load(code, { ...f, [k]: v === ALL || v === '' ? undefined : v });

  const rangeTooLarge = !res.ok && res.code === 'inventory.range_too_large';
  const exportHref = `/inventory/reports/${code}/export?${new URLSearchParams(toReportQuery(code, f)).toString()}`;
  const exportable = p.canExport && (code !== 'cost_per_test' || p.canCost);

  return (
    <section aria-label="Reports">
      <PageHeader
        title="Reports"
        helpKey="inventory.help.consumption_model"
        {...(exportable ? { actions: <a className="lims-btn lims-btn-secondary lims-btn-md" href={exportHref}>Export CSV</a> } : {})}
      />
      <Stack>
        <a className="lims-link" href={CONSUMPTION_HELP}>Help: how automatic deduction works</a>
        <ProblemBanner problem={exportProblem} />
        <Tabs aria-label="Reports" items={p.tabs.map((t) => ({ id: t, label: TAB_LABEL[t] }))} selectedId={code} onChange={(id) => void load(id as ReportCode, f)}>
          <Stack>
            <Inline gap={2}>
              {DATED.has(code) ? (
                <DateRangePicker
                  label="Period"
                  name="period"
                  maxDays={MAX_DAYS}
                  {...(f.from && f.to ? { value: { from: f.from as IsoDate, to: f.to as IsoDate } } : {})}
                  {...(rangeTooLarge ? { error: `Choose a period of at most ${MAX_DAYS} days` } : {})}
                  onChange={(v) => {
                    if (v) void load(code, { ...f, from: v.from, to: v.to });
                  }}
                />
              ) : null}
              {code === 'expiry' ? (
                <DecimalField
                  label="Expiring within (days)"
                  name="within_days"
                  decimals={0}
                  {...(f.within_days ? { value: f.within_days } : {})}
                  onChange={(v) => v && Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 365 && void load(code, { ...f, within_days: v })}
                />
              ) : null}
              {code === 'stock_valuation' ? (
                <DateTimePicker
                  label="As of"
                  name="as_of"
                  value={(f.as_of ?? p.nowIso) as IsoUtc}
                  onChange={(v) => {
                    if (v) void load(code, { ...f, as_of: v });
                  }}
                />
              ) : null}
              {code !== 'consumption_reconciliation' ? <Pick label="Store" name="store_id" options={[{ value: ALL, label: 'All stores' }, ...p.stores.map((s) => ({ value: s.id, label: `${s.store_code} · ${s.name}` }))]} value={f.store ?? ALL} onChange={set('store')} /> : null}
              {BY_ANALYSER_AND_TEST.has(code) ? <Pick label="Analyser" name="instrument_id" options={[{ value: ALL, label: 'All analysers' }, ...p.instruments.map((i) => ({ value: i.id, label: `${i.instrument_code} · ${i.display_name}` }))]} value={f.analyser ?? ALL} onChange={set('analyser')} /> : null}
              {BY_ANALYSER_AND_TEST.has(code) ? <Pick label="Test" name="test_id" options={[{ value: ALL, label: 'All tests' }, ...p.tests.map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }))]} value={f.test ?? ALL} onChange={set('test')} /> : null}
              {/* Item filter (04-UI-UX S17 "Common filters: … item"): clearing the text = all items. Navigates (server render) because the item list is searched, not preloaded. */}
              <Combobox<ItemSummary>
                label="Item"
                name="item_id"
                loadOptions={async (q) => {
                  const r = await searchItemsAction(q);
                  return r.ok ? r.data : [];
                }}
                getKey={(i) => i.id}
                renderOption={(i) => `${i.item_code} · ${i.name}`}
                renderValue={(i) => `${i.item_code} · ${i.name}`}
                value={item}
                onChange={(v) => {
                  setItem(v);
                  router.replace(`${path}?${toPageQuery(code, { ...f, item: v?.id })}`);
                }}
              />
            </Inline>
            {loading ? <p role="status">Loading report…</p> : res.ok ? <ReportBody code={code} result={res.data} canCost={p.canCost} /> : rangeTooLarge ? null : (
              <div role="alert">
                <ErrorState title={res.title || 'The report could not be loaded'} {...(res.requestId ? { requestId: res.requestId } : {})} />
              </div>
            )}
          </Stack>
        </Tabs>
      </Stack>
    </section>
  );
}
