'use client';
// 04-UI-UX §2.4 Levey-Jennings chart. LD-140: @lims/ui only. Until CR-C9-007 (ControlChart) merges, the chart is a DataTable of the same points + a note (03-APP-FLOW §4);
// the table is also what AC-08.5 asks for beside the chart, so it stays when the chart arrives.
// T0D-UIDASH-1 (LD-353 rule 8): the development note banner is gone from the page; no colour literals (accent plus grey from tokens).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateRangePicker, type DateRange } from '@lims/ui/components/DateRangePicker';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { POINT, fixed, rulesText, z2 } from '../format';
import { excludeObservationAction, pollLjAction } from '../server/actions';
import type { CodeOption, LjChart, LjPoint, LjSeries, LjTarget, StatusRow } from '../types';
import { usePolled } from './polling';
import { ConnectionLost, UpdatedAt, qs, useAttemptKey } from './Shared';

type Iso = DateTextProps['value'];
const TITLE = t('quality.nav.lj_chart'); // T0D-ELABMENU-3 (LD-340): ElabAssist menu label
const SIGMA = [['+1SD', 1], ['−1SD', -1], ['+2SD', 2], ['−2SD', -2], ['+3SD', 3], ['−3SD', -3]] as const;
const FAIL = { 'common.version_conflict': 'This value changed. Reload the page and try again.', 'quality.qc_run_already_evaluated': 'This value belongs to an evaluated run and can no longer be excluded.' } as Record<string, string>;

type Common = { sp: Record<string, string>; plans: StatusRow[] };
export interface LjViewProps extends Common { chart?: LjChart; generatedAt: string; canManage: boolean; exclusionOptions: CodeOption[] }

export function LjView(p: LjViewProps) {
  return p.chart ? <ChartView {...p} chart={p.chart} /> : (
    <>
      <PageHeader title={t('quality.nav.lj_chart')} helpKey="quality.lj_chart" />
      <Controls {...p} />
      <EmptyState title="Choose a plan" body="Pick an instrument and analyte to see its QC values over time." />
    </>
  );
}

const planLabel = (r: StatusRow) => `${r.instrument_label} · ${r.analyte_code}`;

function useGo(sp: Record<string, string>) {
  const router = useRouter();
  return { router, go: (patch: Record<string, string | undefined>) => router.push(`/quality/lj${qs({ ...sp, ...patch })}`) };
}

/** Plan, view, level, lot and period; the query state lives in the URL (UUIDs and dates only). */
function Controls({ sp, plans, chart }: Common & { chart?: LjChart }) {
  const { go } = useGo(sp);
  const planId = sp['plan_id'];
  const options = plans.map((r) => ({ value: r.plan_id, label: planLabel(r) }));
  if (planId && chart && !options.some((o) => o.value === planId)) options.push({ value: planId, label: chart.plan.analyte_code });
  const levels = chart ? [...new Map(chart.series.map((s) => [s.level_id, s.level_code])).entries()].map(([value, label]) => ({ value, label })) : [];
  const lots = chart ? [...new Map(chart.series.map((s) => [s.lot_id, s.lot_no])).entries()].map(([value, label]) => ({ value, label })) : [];
  const view = chart?.view ?? 'level';
  const from = sp['from'];
  const to = sp['to'];
  // T0D-UIGUARD-1-QUALITY (LD-353 rule 2, LD-441): the kit FilterBar; the URL driven controls are its children.
  return (
    <FilterBar aria-label="Chart filters">
      {options.length ? <Select label="Plan" name="plan_id" options={options} {...(planId ? { value: planId } : {})} onChange={(v) => go({ plan_id: v, level_id: undefined, lot_id: undefined })} /> : null}
      {chart ? (
        <>
          <RadioGroup<'level' | 'z'>
            label="View" name="view" orientation="horizontal" value={view}
            options={[{ value: 'level', label: 'One level' }, { value: 'z', label: 'All levels (SD units)' }]}
            onChange={(v) => go({ view: v, ...(v === 'level' ? { level_id: sp['level_id'] ?? chart.series[0]?.level_id } : {}) })}
          />
          {view === 'level' && levels.length ? <Select label="Level" name="level_id" options={levels} {...(sp['level_id'] ? { value: sp['level_id'] } : {})} onChange={(v) => go({ level_id: v, view: 'level' })} /> : null}
          {lots.length ? <Select label="Lot" name="lot_id" options={[{ value: 'all', label: 'All lots' }, ...lots]} value={sp['lot_id'] ?? 'all'} onChange={(v) => go({ lot_id: v === 'all' ? undefined : v })} /> : null}
          <DateRangePicker label="Period" name="period" maxDays={400} {...(from && to ? { value: { from: from as DateRange['from'], to: to as DateRange['to'] } } : {})} onChange={(r) => go({ from: r?.from, to: r?.to })} />
        </>
      ) : null}
    </FilterBar>
  );
}

const current = (s: LjSeries): LjTarget | undefined => [...s.targets].sort((a, b) => a.effective_from.localeCompare(b.effective_from)).at(-1);
const cv = (t: LjTarget) => (Number(t.mean) ? `${Math.round((Number(t.sd) / Math.abs(Number(t.mean))) * 100)}%` : '—');

function ChartView({ chart, generatedAt, sp, plans, canManage, exclusionOptions }: LjViewProps & { chart: LjChart }) {
  const { router } = useGo(sp);
  const toast = useToast();
  const { data, updatedAt, lost } = usePolled(chart, generatedAt, () => pollLjAction(sp), JSON.stringify(sp));
  const [drawer, setDrawer] = useState<LjPoint>();
  const [excluding, setExcluding] = useState<LjPoint>();
  const [error, setError] = useState<string>();
  const key = useAttemptKey();
  const d = data.plan.decimals;
  const z = data.view === 'z';
  const withRun = (pt: LjPoint) => canManage && pt.status !== 'excluded' && (!pt.qc_run_id || pt.status === 'collecting');

  const columns: ColumnDef<LjPoint>[] = [
    { id: 'at', header: 'Time', isRowHeader: true, cell: (r) => <DateText value={r.observed_at as Iso} withTime /> },
    { id: 'value', header: 'Value', align: 'end', cell: (r) => fixed(r.value, d) },
    { id: 'z', header: 'z', align: 'end', cell: (r) => z2(r.z) },
    { id: 'status', header: 'Status', cell: (r) => <StatusChip kind="generic" status={r.status} label={`${POINT[r.status].marker} ${POINT[r.status].label}`} tone={POINT[r.status].tone} /> },
    { id: 'rules', header: 'Rule hits', cell: (r) => rulesText(r.rule_hits) },
  ];

  const confirmExclude = async ({ reasonCode, reasonText }: { reasonCode?: string; reasonText?: string }) => {
    if (!excluding || !reasonCode) return;
    const res = await excludeObservationAction(data.plan.id, excluding.observation_id, excluding.observed_at, reasonCode, reasonText ?? '', key.keyFor(`${excluding.observation_id}|${reasonCode}|${reasonText ?? ''}`));
    if (res.ok) {
      key.done();
      setExcluding(undefined);
      toast.show({ tone: 'success', title: 'Value excluded from QC' });
      router.refresh();
    } else setError(FAIL[res.code] ?? 'The value could not be excluded. Try again.');
  };

  return (
    <>
      <PageHeader title={`${TITLE} · ${data.plan.analyte_code}`} helpKey="quality.lj_chart" status={<UpdatedAt at={updatedAt} />} />
      {lost ? <ConnectionLost since={updatedAt} /> : null}
      <Controls sp={sp} plans={plans} chart={data} />
      {data.truncated ? <Banner tone="warning" title="Showing the newest 2,000 points. Narrow the period to see all." /> : null}
      {/* T0D-UIGUARD-1-QUALITY (LD-436 R7, LD-439): no raw ul for page structure; the items keep list semantics. */}
      <section aria-label="Legend">
        <div role="list">{(Object.keys(POINT) as (keyof typeof POINT)[]).map((s) => <div role="listitem" key={s}>{`${POINT[s].marker} ${POINT[s].label}`}</div>)}</div>
      </section>
      {/* T0D-EMPTYTBL-2 (LD-310, LD-336): no series = the points table with its headers and the message in its body. */}
      {data.series.length === 0 ? <DataTable<LjPoint> columns={columns} rows={[]} getRowId={(r) => r.observation_id} density="compact" caption="QC points" emptyState={{ title: 'No QC values in this period.' }} /> : null}
      {data.series.map((s) => {
        const t = current(s);
        const rejected = s.points.filter((x) => x.status === 'rejected').length;
        const group = `${s.level_code} · ${s.lot_no}`;
        return (
          <Card key={`${s.level_id}-${s.lot_id}`} title={group}>
            <p>{`${data.series.length > 1 ? `${group}: ` : ''}${s.points.length} points, ${rejected} rejected${t ? `, current target mean ${fixed(t.mean, d)}, SD ${fixed(t.sd, d)}` : ''}.`}</p>
            {t ? (
              <DescriptionList items={[
                { term: 'Mean', value: fixed(t.mean, d) }, { term: 'SD', value: fixed(t.sd, d) }, { term: 'CV', value: cv(t) }, { term: 'Source', value: t.source },
                { term: 'Effective from', value: <DateText value={t.effective_from as Iso} withTime /> },
              ]} />
            ) : null}
            {!z ? (
              <div role="list" aria-label={`Target lines ${group}`}>
                {[...s.targets].sort((a, b) => a.effective_from.localeCompare(b.effective_from)).map((tg, i) => (
                  <div role="listitem" key={tg.target_id}>
                    {`Target v${i + 1} (${tg.source})`}
                    <div role="list">
                      <div role="listitem">{`Mean ${fixed(tg.mean, d)}`}</div>
                      {SIGMA.map(([l, k]) => <div role="listitem" key={l}>{`${l} ${fixed(String(Number(tg.mean) + k * Number(tg.sd)), d)}`}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <DataTable<LjPoint>
              columns={columns} rows={s.points} getRowId={(r) => r.observation_id} density="compact" caption={`${group} points`}
              onRowAction={(r) => { setError(undefined); setDrawer(r); }}
              emptyState={{ title: 'No QC values in this period.' }}
            />
          </Card>
        );
      })}

      <Drawer title="Observation" isOpen={!!drawer} onClose={() => setDrawer(undefined)}>
        {drawer ? (
          <>
            <DescriptionList items={[
              { term: 'Observed at', value: <DateText value={drawer.observed_at as Iso} withTime /> },
              { term: 'Value', value: fixed(drawer.value, d) },
              { term: 'z', value: z2(drawer.z) },
              { term: 'Status', value: `${POINT[drawer.status].marker} ${POINT[drawer.status].label}` },
              { term: 'Rule hits', value: rulesText(drawer.rule_hits) },
            ]} />
            {drawer.qc_run_id ? <a className="lims-btn lims-btn-secondary" href={`/quality/qc-runs/${drawer.qc_run_id}`}>Open run</a> : null}
            {withRun(drawer) ? <Button variant="danger" onPress={() => { setError(undefined); setExcluding(drawer); setDrawer(undefined); }}>Exclude</Button> : null}
          </>
        ) : null}
      </Drawer>
      <ConfirmDialog
        title="Exclude this value from QC?" tone="danger" confirmLabel="Exclude" isOpen={!!excluding} onCancel={() => setExcluding(undefined)}
        body={<><p>The value stays in the record and is marked excluded. It no longer counts for any QC rule.</p>{error ? <p role="alert">{error}</p> : null}</>}
        requireReason={{ codedSet: 'quality.exclusion_reasons', options: exclusionOptions.filter((o) => o.isActive), freeText: { maxLength: 500, isRequired: false } }}
        onConfirm={confirmExclude}
      />
    </>
  );
}
