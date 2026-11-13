'use client';
// 04-UI-UX §2.4 Gateway reconciliation: tiles, Runs tab, Open findings tab. Severity and automatic action are written in words.
// Reconciliation never claims it changed the ledger unless the server says so (`auto_action`); nothing here marks a payment paid.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile } from '@lims/ui/components/StatTile';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { failText } from '../errors';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { hasPerm, humanize, instantText, kitMoney, statusLabel } from '../labels';
import { resolveFindingAction, startReconciliationAction, type ActionResult } from '../server/actions';
import type { FindingDto, PaymentMoney, ReconCodes, ReconStats, ReconciliationRunDto } from '../types';

/** Standalone amount via kit MoneyText (04-UI-UX:21); em dash when absent. */
const amt = (m: PaymentMoney | undefined) => { const k = kitMoney(m); return k ? <MoneyText value={k} /> : <span className="lims-money">—</span>; };

type Iso = DateTextProps['value'];
type Fail = Extract<ActionResult, { ok: false }>;
const ALL = 'all';
const BASE = '/payments/reconciliation';
const SEVERITY = { critical: ['danger', 'Critical'], warning: ['warning', 'Warning'], info: ['neutral', 'Info'] } as const;
const RUN_STATUS = { running: ['info', 'Running'], completed: ['success', 'Completed'], failed: ['danger', 'Failed'] } as const;
const AUTO_ACTION: Record<string, string> = { settled: 'Marked paid', held: 'Put under review', ledger_repaired: 'Ledger repaired' };
const SEVERITY_OPTIONS = [{ value: ALL, label: 'All' }, { value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }];

export interface FindingsFilter { kind: readonly string[]; severity?: string }
export interface ReconciliationViewProps {
  runs: readonly ReconciliationRunDto[];
  findings: readonly FindingDto[];
  stats: ReconStats;
  permissions: readonly string[];
  codes: ReconCodes;
  filter?: FindingsFilter;
  nextCursor?: string;
  hasPrevious?: boolean;
}

const when = (v: string | undefined, time = false) => (v ? <DateText value={v as Iso} {...(time ? { withTime: true } : {})} /> : '—');
/** The status chip text for "our status" (a payment intent). `initiated` reads "Started" on the payment screens. */
const ourStatus = (s: string | undefined) => (s ? (s === 'initiated' ? 'Started' : statusLabel(s)) : '—');
const sev = (s: string) => (Object.hasOwn(SEVERITY, s) ? SEVERITY[s as keyof typeof SEVERITY] : (['neutral', humanize(s)] as const));

export function ReconciliationView({ runs, findings, stats, permissions, codes, filter, nextCursor, hasPrevious }: ReconciliationViewProps) {
  const router = useRouter();
  const toast = useToast();
  const canResolve = hasPerm(permissions, 'payments.intent.resolve');
  const [tab, setTab] = useState('runs');
  const [dlg, setDlg] = useState<{ finding: FindingDto; key: string } | null>(null);
  const [needText, setNeedText] = useState(false);
  const [banner, setBanner] = useState('');
  const starting = useRef(false);
  const kindName = new Map(codes.finding_kinds.map((k) => [k.code, k.display]));

  const runNow = async () => {
    if (starting.current || !canResolve) return;
    starting.current = true;
    try {
      const res = await startReconciliationAction(globalThis.crypto.randomUUID());
      if (res.ok) {
        toast.show({ tone: 'success', title: 'Reconciliation started.' });
        router.refresh();
      } else toast.show({ tone: res.code === 'payments.reconciliation_in_progress' ? 'info' : 'danger', title: failText(res) });
    } finally {
      starting.current = false;
    }
  };

  const resolve = async (r: { reasonCode?: string; reasonText?: string }) => {
    if (!dlg) return;
    const picked = codes.finding_resolutions.find((x) => x.code === r.reasonCode);
    if (!r.reasonCode || (picked?.requires_text && !r.reasonText?.trim())) { setNeedText(true); return; }
    const res = await resolveFindingAction(dlg.finding.id, dlg.finding.version, r.reasonCode, r.reasonText, dlg.key);
    setDlg(null);
    setNeedText(false);
    if (res.ok) {
      toast.show({ tone: 'info', title: 'Finding resolved.' });
      router.refresh();
    } else setBanner(failText(res as Fail));
  };

  const runCols: ColumnDef<ReconciliationRunDto>[] = [
    { id: 'date', header: 'Business date', isRowHeader: true, cell: (r) => when(r.business_date) },
    { id: 'trigger', header: 'Trigger', cell: (r) => (r.trigger === 'manual' ? 'Manual' : 'Nightly') },
    { id: 'status', header: 'Status', cell: (r) => { const [tone, label] = Object.hasOwn(RUN_STATUS, r.status) ? RUN_STATUS[r.status as keyof typeof RUN_STATUS] : (['neutral', humanize(r.status)] as const); return <StatusChip kind="generic" status={r.status} tone={tone} label={label} />; } },
    { id: 'checked', header: 'Checked', align: 'end', cell: (r) => String(r.counts?.checked ?? 0) },
    { id: 'ok', header: 'OK', align: 'end', cell: (r) => String(r.counts?.ok ?? 0) },
    { id: 'findings', header: 'Findings', align: 'end', cell: (r) => String(r.counts?.findings ?? 0) },
    { id: 'critical', header: 'Critical', align: 'end', cell: (r) => String(r.counts?.critical ?? 0) },
    { id: 'finished', header: 'Finished', cell: (r) => when(r.finished_at, true) },
  ];
  const findingCols: ColumnDef<FindingDto>[] = [
    { id: 'found', header: 'Found', isRowHeader: true, cell: (f) => when(f.created_at, true) },
    { id: 'severity', header: 'Severity', cell: (f) => { const [tone, label] = sev(f.severity); return <StatusChip kind="generic" status={f.severity} tone={tone} label={label} />; } },
    { id: 'kind', header: 'Kind', cell: (f) => kindName.get(f.kind) ?? humanize(f.kind) },
    { id: 'intent', header: 'Intent', cell: (f) => (f.intent_id ? <a href={`/payments/intents/${f.intent_id}`} aria-label={`Payment ${f.intent_id.slice(0, 8)}`}><IdText value={f.intent_id} /></a> : '—') },
    { id: 'our_status', header: 'Our status', cell: (f) => ourStatus(f.our_status) },
    { id: 'provider_status', header: 'Provider status', cell: (f) => f.gateway_status_raw ?? '—' },
    { id: 'our_amount', header: 'Our amount', align: 'end', cell: (f) => amt(f.our_amount) },
    { id: 'provider_amount', header: 'Provider amount', align: 'end', cell: (f) => amt(f.gateway_amount) },
    { id: 'auto', header: 'Automatic action', cell: (f) => (f.auto_action ? AUTO_ACTION[f.auto_action] ?? '—' : '—') },
    { id: 'actions', header: 'Actions', cell: (f) => <Button size="sm" isDisabled={!canResolve} onPress={() => { setNeedText(false); setBanner(''); setDlg({ finding: f, key: globalThis.crypto.randomUUID() }); }}>Resolve</Button> },
  ];

  const f: FindingsFilter = filter ?? { kind: [] };
  const filters: FilterDef[] = [
    { id: 'kind', label: 'Kind', kind: 'select', multiple: true, options: codes.finding_kinds.map((k) => ({ value: k.code, label: k.display })) },
    { id: 'severity', label: 'Severity', kind: 'select', options: SEVERITY_OPTIONS },
  ];
  const value: FilterValue = { kind: f.kind, severity: f.severity ?? ALL };
  const go = (v: FilterValue, cursor?: string) => {
    const p = new URLSearchParams();
    const one = (k: string, x: string | readonly string[] | undefined) => { const j = typeof x === 'string' ? x : x?.join(','); if (j && j !== ALL) p.set(k, j); };
    one('kind', v['kind']); one('severity', v['severity']);
    if (cursor) p.set('cursor', cursor);
    const s = p.toString();
    router.push(s ? `${BASE}?${s}` : BASE);
  };

  return (
    <>
      <PageHeader title="Gateway reconciliation" helpKey="payments.reconciliation" actions={canResolve ? <Button variant="primary" onPress={() => void runNow()}>Run now</Button> : null} />
      {banner ? <div role="alert"><Banner tone="danger" title={banner} /></div> : null}
      <div className="lims-stat-row">
        <StatTile label="Last successful run" value={stats.lastSuccessfulRunAt ? instantText(stats.lastSuccessfulRunAt) : 'Never'} />
        {/* the leading space keeps label and value apart in the element's plain text (the tile renders them as adjacent spans) */}
        <StatTile label="Open critical findings" value={` ${stats.openCritical}`} />
        <StatTile label="Payments under review" value={` ${stats.underReview}`} href="/payments/review" />
      </div>
      <Tabs aria-label="Reconciliation" selectedId={tab} onChange={setTab} items={[{ id: 'runs', label: 'Runs' }, { id: 'findings', label: 'Open findings' }]}>
        {tab === 'runs' ? (
          <DataTable<ReconciliationRunDto>
            columns={runCols} rows={runs} getRowId={(r) => r.id} density="compact" caption="Reconciliation runs"
            emptyState={{ title: 'No reconciliation runs yet.', body: 'Nightly runs will be listed here.' }}
          />
        ) : (
          <>
            <FilterBar filters={filters} value={value} onChange={go} onReset={() => router.push(BASE)} />
            <DataTable<FindingDto>
              columns={findingCols} rows={findings} getRowId={(r) => r.id} density="compact" caption="Open findings"
              emptyState={{ title: 'No open findings.', body: 'Differences with the provider appear here.' }}
              {...(nextCursor || hasPrevious ? { page: { hasNext: !!nextCursor, hasPrevious: !!hasPrevious, onNext: () => nextCursor && go(value, nextCursor), onPrevious: () => router.back(), limit: 50 } } : {})}
            />
          </>
        )}
      </Tabs>
      {dlg ? (
        <ConfirmDialog
          key={dlg.key} isOpen title="Resolve finding?" confirmLabel="Resolve" onCancel={() => { setNeedText(false); setDlg(null); }} onConfirm={resolve}
          body={<><p>Record why this finding needs no further action.</p>{needText ? <p role="alert" className="lims-error">Enter details for this reason.</p> : null}</>}
          requireReason={{ codedSet: 'payments.finding_resolutions', options: codes.finding_resolutions, freeText: { maxLength: 1000, isRequired: false } }}
        />
      ) : null}
    </>
  );
}
