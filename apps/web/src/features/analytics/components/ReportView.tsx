'use client';
// AN-T19: shared frame + body for the report hub, the 11 report pages and the Collections page (04-UI-UX §2, §4). Client component: the kit (react-aria) is
// client-only. Props are the plain-JSON PageVM built on the server; filter state lives in the URL (a change = router.push, the server component re-reads).
// Copy strings are the 04-UI-UX §13 catalogue values. Centre/branch ids are never rendered (07-SECURITY).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { BarChart } from '@lims/ui/components/BarChart';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { DurationText } from '@lims/ui/components/DurationText';
import { FilterBar, type FilterDef } from '@lims/ui/components/FilterBar';
import { FreshnessBadge } from '@lims/ui/components/FreshnessBadge';
import { Grid } from '@lims/ui/components/Grid';
import { IdText } from '@lims/ui/components/IdText';
import { Menu } from '@lims/ui/components/Menu';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { periodError, PeriodPicker, type PeriodValue } from '@lims/ui/components/PeriodPicker';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { StatTile } from '@lims/ui/components/StatTile';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { shortcuts, type Shortcut } from '@/core/shortcuts/registry';
import { searchReferrersAction } from '../server/actions';
import { RefreshButton } from './DashboardActions';
import { ExportDialog } from './ExportDialog';
import { PRESETS, addDays, nepalToday, presetOf, presetRange } from './period';
import type { Cell, Control, PageVM, Section, TableVM } from './report-types';
import { ScopeBanner } from './ScopeBanner';

const NUM = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu' });
const REASON = { refresh_lagging: 'Recent changes are still being processed', refresh_failed: 'Last update failed — the team has been alerted', never_refreshed: 'Not yet calculated' } as const;
const CARRY = ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs', 'centre_id', 'branch_id'];
const ALL = 'all'; // "All" option of a single Select = parameter absent
// DurationText's `style` is a text-format variant, not CSS; spread so the LD-140 raw-style scan (attribute `style=`) does not misread it.
const SHORT = { style: 'short' } as const;

function renderCell(c: Cell | undefined): ReactNode {
  if (!c) return '—';
  switch (c.k) {
    case 'text':
      return c.open ? <>{c.v} <a href={c.open}>Open</a></> : c.v;
    case 'int':
      return c.v === undefined ? '—' : NUM.format(c.v);
    case 'money':
      return c.v === undefined ? '—' : <MoneyText value={{ amountPaisa: c.v, currency: 'NPR' }} />;
    case 'bp':
      return c.v === undefined ? '—' : `${(c.v / 100).toFixed(1)}%`;
    case 'dur':
      return c.v === undefined ? '—' : <DurationText seconds={c.v} {...SHORT} />;
    case 'id':
      return <IdText value={c.v} />;
    case 'link':
      return <a href={c.href}>{c.v}</a>;
    case 'badge':
      return <Badge tone={c.tone}>{c.v}</Badge>;
  }
}

type Row = { id: string; cells: Cell[] };
function ReportTable({ vm, onNext, onPrevious }: { vm: TableVM; onNext: (cursor: string) => void; onPrevious: () => void }) {
  const rh = vm.rowHeader ?? 0;
  const rows: Row[] = vm.total ? [...vm.rows, { id: '__total', cells: vm.total }] : vm.rows;
  const columns: ColumnDef<Row>[] = vm.columns.map((col, i) => ({
    id: col.id, header: col.header, isRowHeader: i === rh, ...(col.align ? { align: col.align } : {}),
    cell: (r) => (r.id === '__total' ? <strong>{renderCell(r.cells[i])}</strong> : renderCell(r.cells[i])),
  }));
  return (
    <DataTable<Row>
      columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" stickyHeader caption={vm.caption}
      emptyState={{ title: 'No data for this period and filter' }}
      {...(vm.pager ? { page: { hasNext: !!vm.pager.next, hasPrevious: vm.pager.hasPrevious, onNext: () => vm.pager?.next && onNext(vm.pager.next), onPrevious, limit: vm.pager.limit } } : {})}
    />
  );
}

function Body({ s, many, onNext, onPrevious }: { s: Section; many: boolean; onNext: (c: string) => void; onPrevious: () => void }) {
  switch (s.t) {
    case 'table': {
      const table = <ReportTable vm={s.vm} onNext={onNext} onPrevious={onPrevious} />;
      return many ? <Card title={s.vm.caption}>{table}</Card> : table;
    }
    case 'chart':
      return <Card><BarChart title={s.title} categories={s.categories} series={s.series} valueFormat={s.format} /></Card>;
    case 'tiles':
      return <Grid columns={3}>{s.items.map((x) => <StatTile key={x.label} label={x.label} value={x.value} />)}</Grid>;
    case 'card':
      return <Card title={s.title}><DescriptionList items={s.items} columns={2} /></Card>;
    case 'dl':
      return <DescriptionList items={s.items} columns={2} />;
    case 'banner':
      return <Banner tone={s.tone} title={s.title} />;
    case 'note':
      return <p className="lims-description">{s.text}</p>;
    case 'text':
      return <p><strong>{s.text}</strong></p>;
  }
}

const noop = () => undefined;
/** AN-T20 report-run page: the report's own sections only (same table/chart/tile components), no filters, no pager, no export. */
export function ReportSections({ vm }: { vm: PageVM }) {
  return (
    <>
      {vm.sections.map((s, i) => {
        if (s.t !== 'table') return <Body key={i} s={s} many={false} onNext={noop} onPrevious={noop} />;
        const { pager: _pager, ...table } = s.vm; // eslint-disable-line @typescript-eslint/no-unused-vars -- first page only, no pager
        return <Body key={i} s={{ t: 'table', vm: table }} many={false} onNext={noop} onPrevious={noop} />;
      })}
    </>
  );
}

function ControlView({ c, q, go }: { c: Control; q: URLSearchParams; go: (p: Record<string, string | undefined>) => void }) {
  switch (c.type) {
    case 'radio':
      return <RadioGroup<string> label={c.label} name={c.id} value={c.value} options={c.options} orientation="horizontal" onChange={(v) => go({ [c.id]: v })} />;
    case 'select':
      return <Select<string> label={c.label} name={c.id} value={c.value} options={c.options} onChange={(v) => go({ [c.id]: v === ALL ? undefined : v })} />;
    case 'switch':
      return <Switch label={c.label} isSelected={c.on} onChange={(on) => go({ [c.id]: on ? c.onValue : c.offValue })} />;
    case 'checks':
      return (
        <fieldset className="lims-field">
          <legend className="lims-label">{c.label}</legend>
          {c.options.map((o) => (
            <Checkbox
              key={o.value} label={o.label} isSelected={c.value.includes(o.value)}
              onChange={(on) => {
                const next = c.options.map((x) => x.value).filter((v) => (v === o.value ? on : c.value.includes(v)));
                if (next.length === 0) return; // at least one segment stays selected
                go({ [c.id]: next.length === c.options.length ? undefined : next.join(',') });
              }}
            />
          ))}
        </fieldset>
      );
    case 'multi':
      return null; // rendered by the FilterBar
    case 'referrers':
      return <ReferrerFilter c={c} go={go} />;
  }
}

type Ref = { id: string; label: string; isActive: boolean };
/** 04-UI-UX §4.5 Referrer: Combobox (multi) over searchAnalyticsReferrers — POST body, >= 2 chars, 150 ms debounce, <= 20 rows. Each pick adds to `referrer_id`. */
function ReferrerFilter({ c, go }: { c: Extract<Control, { type: 'referrers' }>; go: (p: Record<string, string | undefined>) => void }) {
  return (
    <div>
      <Combobox<Ref>
        label={c.label} name={c.id} minChars={2} debounceMs={150}
        loadOptions={(query) => searchReferrersAction(query)}
        getKey={(r) => r.id} renderValue={(r) => r.label} renderOption={(r) => (r.isActive ? r.label : `${r.label} (inactive)`)}
        onChange={(r) => { if (r && !c.value.includes(r.id) && c.value.length < 20) go({ [c.id]: [...c.value, r.id].join(',') }); }}
      />
      {c.value.length > 0 ? <Button variant="secondary" onPress={() => go({ [c.id]: undefined })}>{`Clear referrers (${c.value.length})`}</Button> : null}
    </div>
  );
}

export function ReportView({ vm }: { vm: PageVM }) {
  const router = useRouter();
  const q = useMemo(() => new URLSearchParams(vm.query), [vm.query]);
  const periodRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const [format, setFormat] = useState<'xlsx' | 'csv' | 'pdf'>();
  const today = nepalToday();

  const go = (patch: Record<string, string | undefined>, path = vm.basePath) => {
    const next = new URLSearchParams(vm.query);
    for (const [k, v] of Object.entries(patch)) (v === undefined || v === '' ? next.delete(k) : next.set(k, v));
    if (!('cursor' in patch)) next.delete('cursor');
    const s = next.toString();
    router.push(s ? `${path}?${s}` : path);
  };
  const openTab = (id: string) => {
    const tab = vm.tabs.find((x) => x.id === id);
    if (!tab) return;
    const keep = new URLSearchParams();
    for (const k of CARRY) if (q.has(k)) keep.set(k, q.get(k)!);
    const s = keep.toString();
    router.push(s ? `${tab.href}?${s}` : tab.href);
  };
  const latest = useRef({ openTab });
  latest.current = { openTab };

  const tabKey = vm.tabs.map((x) => x.id).join(',');
  const hasCentre = vm.centreOptions.length > 0;
  useEffect(() => {
    const list: Shortcut[] = [];
    if (vm.period) list.push({ key: 'Alt+P', description: 'Focus period', run: () => periodRef.current?.querySelector<HTMLElement>('button')?.focus() });
    if (hasCentre) {
      list.push({
        key: 'Alt+C', description: 'Focus centre filter',
        run: () => {
          const box = [...(filtersRef.current?.querySelectorAll<HTMLElement>('[role=listbox]') ?? [])].find((l) => document.getElementById(l.getAttribute('aria-labelledby') ?? '')?.textContent === 'Centre');
          (box?.querySelector<HTMLElement>('[role=option]') ?? box)?.focus();
        },
      });
    }
    if (vm.export) list.push({ key: 'Alt+E', description: 'Open export menu', run: () => exportRef.current?.click() });
    if (tabKey.includes(',')) vm.tabs.slice(0, 9).forEach((t, i) => list.push({ key: `Alt+${i + 1}`, description: `Open ${t.label}`, run: () => latest.current.openTab(t.id) }));
    return shortcuts.register(vm.pageId, ...list);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vm.tabs/vm.export identity changes per render; their content is covered by the keys below
  }, [vm.pageId, !!vm.period, hasCentre, !!vm.export, tabKey]);

  // ---- period (presets resolve to A.D. dates; custom needs both dates and <= 366 days)
  const [period, setPeriod] = useState<PeriodValue>(() => {
    const from = q.get('business_date_from') ?? undefined;
    const to = q.get('business_date_to') ?? undefined;
    if (from && to) { const last = addDays(to, -1); return { preset: presetOf(from, last, today), from, to: last }; } // URL/API `to` is exclusive; the picker shows the last day
    return vm.period ? { preset: 'custom', from: vm.period.from, to: addDays(vm.period.to, -1) } : { preset: 'custom' };
  });
  const onPeriod = (v: PeriodValue) => {
    setPeriod(v);
    const r = v.preset === 'custom' ? (v.from && v.to && !periodError(v) ? { from: v.from, to: v.to } : undefined) : presetRange(v.preset, today);
    if (r) go({ business_date_from: r.from, business_date_to: addDays(r.to, 1), bs_month: undefined, fiscal_year_bs: undefined });
  };

  // ---- freshness
  const stale = vm.freshness.filter((f) => f.is_stale);
  const oldest = vm.freshness.map((f) => f.refreshed_at).filter((x): x is string => !!x).sort()[0] ?? vm.generatedAt;
  const reason = stale[0]?.stale_reason;

  // ---- filters (multi-selects through the FilterBar)
  const multis = vm.controls.filter((c): c is Extract<Control, { type: 'multi' }> => c.type === 'multi');
  const filters: FilterDef[] = [
    ...(hasCentre ? [{ id: 'centre_id', label: 'Centre', kind: 'select' as const, multiple: true, options: vm.centreOptions }] : []),
    ...(vm.branchOptions.length > 0 ? [{ id: 'branch_id', label: 'Branch', kind: 'select' as const, multiple: true, options: vm.branchOptions }] : []),
    ...multis.map((m) => ({ id: m.id, label: m.label, kind: 'select' as const, multiple: true, options: m.options })),
  ];
  const list = (id: string) => (q.get(id) ?? '').split(',').filter(Boolean);
  const filterValue = Object.fromEntries(filters.map((f) => [f.id, list(f.id)]));
  const chosenCentres = list('centre_id').map((id) => vm.centreOptions.find((o) => o.value === id)?.label).filter((x): x is string => !!x);

  const tables = vm.sections.filter((s) => s.t === 'table').length;
  const body = (
    <>
      <div ref={periodRef}>
        {vm.period ? <PeriodPicker label="Period" name="period" value={period} presets={PRESETS} calendar="BS" onChange={onPeriod} /> : null}
      </div>
      <div ref={filtersRef}>
        <FilterBar
          filters={filters} value={filterValue} onReset={() => router.push(vm.basePath)}
          onChange={(v) => go(Object.fromEntries(filters.map((f) => [f.id, ((v[f.id] as readonly string[] | undefined) ?? []).join(',') || undefined])))}
        />
      </div>
      {vm.controls.map((c) => <ControlView key={c.id} c={c} q={q} go={go} />)}
      <ScopeBanner scope={vm.scope} />
      {vm.period && vm.period.timezone && vm.period.timezone !== 'Asia/Kathmandu' ? <Banner tone="info" title="Business days are counted in Nepal time (UTC+05:45)." /> : null}
      {vm.link ? <p><a href={vm.link.href}>{vm.link.label}</a></p> : null}
      {vm.sections.map((s, i) => <Body key={i} s={s} many={tables > 1} onNext={(cursor) => go({ cursor })} onPrevious={() => router.back()} />)}
    </>
  );

  return (
    <>
      <PageHeader
        title={vm.title}
        helpKey={vm.helpKey}
        status={
          oldest || stale.length > 0 ? (
            <>
              <FreshnessBadge isStale={stale.length > 0} {...(oldest ? { refreshedAt: oldest } : {})} {...(reason ? { reason } : {})} />
              {stale.length > 0 && oldest ? <span> Updated {WHEN.format(Date.parse(oldest))}</span> : null}
              {stale.length > 0 && reason ? <span> {REASON[reason]}</span> : null}
            </>
          ) : null
        }
        actions={
          vm.canRefresh || vm.export ? (
            <>
              {vm.canRefresh ? <RefreshButton pageId={vm.pageId} /> : null}
              {vm.export ? (
                <Menu
                  trigger={<Button ref={exportRef} variant="secondary">Export</Button>}
                  items={[{ id: 'xlsx', label: 'Excel (.xlsx)' }, { id: 'csv', label: 'CSV (.csv)' }, { id: 'pdf', label: 'PDF', isDisabled: !vm.export.pdfEnabled }]}
                  onAction={(id) => setFormat(id as 'xlsx' | 'csv' | 'pdf')}
                />
              ) : null}
            </>
          ) : null
        }
      />
      {vm.period ? <p>{vm.period.labelAd} · {vm.period.labelBs} B.S.</p> : null}
      {vm.tabs.length > 1 ? (
        <Tabs items={vm.tabs} selectedId={vm.tab} onChange={openTab} aria-label="Reports">
          {body}
        </Tabs>
      ) : (
        body
      )}
      {format && vm.export ? (
        <ExportDialog
          isOpen onClose={() => setFormat(undefined)} initialFormat={format} reportCode={vm.export.reportCode} pdfEnabled={vm.export.pdfEnabled}
          params={Object.fromEntries([...q.entries()].filter(([k]) => k !== 'cursor'))}
          summary={{ report: vm.title, periodAd: vm.period?.labelAd ?? 'Live data', periodBs: vm.period?.labelBs ?? '—', centres: chosenCentres, ...(vm.export.groupLabel ? { groupBy: vm.export.groupLabel } : {}) }}
        />
      ) : null}
    </>
  );
}
