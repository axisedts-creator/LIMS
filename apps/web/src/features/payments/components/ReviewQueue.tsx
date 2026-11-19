'use client';
// 04-UI-UX §2.1 Payment review queue. Plain-JSON intents from the server page; filters live in the URL (the page re-queries P1).
// Status is always text + tone (StatusChip); money / dates / ids go through the kit; no tokens, return links or provider payloads are read.
// T0D-UICONSOLE-1 (LD-353 template 2 CONSOLE): PageHeader, the same FilterBar, StatTiles (Under review, Waiting for provider, Oldest age under review) above a SplitConsole:
// queue at left (Age first, API order), detail at right (the columns the table had plus History), bar = the existing link to the payment ("(O)", key O). No new action.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SplitConsole } from '@lims/ui/components/SplitConsole';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { t } from '@/core/i18n/messages';
import { gatewayLabel, humanize, nprText } from '../labels';
import { Facts, History, ShortcutKey, hhmm, itemProps, oldest, useNow } from './consoleParts';
import type { ReviewFilter } from '../query';
import type { CodedValue, PaymentCentre, PaymentIntentSummary } from '../types';

type Iso = DateTextProps['value']; // the API sends validated IsoUtc strings; the plain-JSON rows carry them as string
const ALL = 'all';
const STATUS_OPTIONS = [
  ['held_for_review', 'Under review'], ['pending', 'Waiting for provider'], ['initiated', 'Started'], ['failed', 'Failed'], ['expired', 'Expired'], ['settled', 'Paid'],
].map(([value, label]) => ({ value: value!, label: label! }));
const GATEWAY_OPTIONS = [
  { value: ALL, label: 'All' }, { value: 'esewa', label: 'eSewa' }, { value: 'khalti', label: 'Khalti' },
  { value: 'fonepay', label: 'Fonepay — not available yet', isDisabled: true },
];
const BASE = '/payments/review';
const HEADERS = ['Age', 'Created', 'Gateway', 'Amount', 'Status', 'Reason'];

export interface ReviewQueueProps {
  intents: readonly PaymentIntentSummary[];
  permissions: readonly string[];
  centres: readonly PaymentCentre[];
  holdReasons: readonly CodedValue[];
  filter?: ReviewFilter;
  nextCursor?: string;
  hasPrevious?: boolean;
}

export function ReviewQueue({ intents, centres, holdReasons, filter, nextCursor, hasPrevious }: ReviewQueueProps) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string>();
  const f: ReviewFilter = filter ?? { status: ['held_for_review'], created: ['', ''] };
  const reasonName = new Map(holdReasons.map((r) => [r.code, r.display]));

  // Alt+R focuses the filter reset control (04-UI-UX §2.1 [CONV]).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.code !== 'KeyR' && e.key.toLowerCase() !== 'r')) return;
      const reset = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="search"] button') ?? [])].find((b) => /reset/i.test(b.textContent ?? ''));
      if (reset) { e.preventDefault(); reset.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const filters: FilterDef[] = [
    { id: 'status', label: 'Status', kind: 'select', multiple: true, options: STATUS_OPTIONS },
    // Gateway stays a single select: kit MultiSelect has no disabled options for the Fonepay entry (.orchestra/cr/PG-T18.md).
    { id: 'gateway', label: 'Gateway', kind: 'select', options: GATEWAY_OPTIONS },
    { id: 'hold_reason', label: 'Hold reason', kind: 'coded', codedSet: 'payments.hold_reasons', options: [{ code: ALL, display: 'All' }, ...holdReasons.map((r) => ({ code: r.code, display: r.display }))] },
    { id: 'created', label: 'Created', kind: 'date_range' },
    ...(centres.length ? [{ id: 'centre_id', label: 'Centre', kind: 'select' as const, options: [{ value: ALL, label: 'All' }, ...centres.map((c) => ({ value: c.id, label: c.name }))] }] : []),
  ];
  const value: FilterValue = {
    status: f.status, gateway: f.gateway ?? ALL, hold_reason: f.hold_reason ?? ALL, centre_id: f.centre_id ?? ALL,
    ...(f.created[0] && f.created[1] ? { created: [f.created[0], f.created[1]] } : {}),
  };
  const go = (v: FilterValue, cursor?: string) => {
    const p = new URLSearchParams();
    const one = (k: string, x: string | readonly string[] | undefined) => {
      const j = typeof x === 'string' ? x : x?.join(',');
      if (j && j !== ALL) p.set(k, j);
    };
    one('status', v['status']); one('gateway', v['gateway']); one('hold_reason', v['hold_reason']); one('centre_id', v['centre_id']);
    const c = v['created'];
    if (Array.isArray(c) && c.length === 2) { p.set('created_at_from', String(c[0])); p.set('created_at_to', String(c[1])); }
    if (cursor) p.set('cursor', cursor);
    const s = p.toString();
    router.push(s ? `${BASE}?${s}` : BASE);
  };

  const reason = (r: PaymentIntentSummary) => (r.hold_reason ? reasonName.get(r.hold_reason) ?? humanize(r.hold_reason) : r.failure_reason ? humanize(r.failure_reason) : '—');
  const age = (r: PaymentIntentSummary) => now - Date.parse(r.created_at);
  const held = intents.filter((r) => r.status === 'held_for_review');
  const sel = intents.find((r) => r.id === selectedId);
  // route strings kept byte-equal to the pre-console list (rs-c15.static, LD-140)
  const intentHref = (r: PaymentIntentSummary) => `/payments/intents/${r.id}`;
  const orderHref = (r: PaymentIntentSummary) => `/frontdesk/orders/${r.order_id}`;

  const list = (
    <div className="lims-data-table"><div className="lims-table-scroll">
      <table className="lims-table">
        <caption className="lims-visually-hidden">Payments needing review</caption>
        <thead><tr>{HEADERS.map((h) => <th key={h} scope="col" {...(h === 'Amount' ? { className: 'lims-align-end' } : {})}>{h}</th>)}</tr></thead>
        <tbody>
          {intents.length === 0 ? <EmptyRow colSpan={HEADERS.length}><EmptyState title="No payments need review." body="Held payments appear here when a provider answer needs a person." /></EmptyRow> : null}
          {intents.map((r) => (
            <tr key={r.id} {...itemProps(r.id, selectedId, setSelectedId)}>
              <td suppressHydrationWarning>{hhmm(age(r))}</td>
              <td><DateText value={r.created_at as Iso} withTime /></td>
              <td>{gatewayLabel(r.gateway)}</td>
              <td className="lims-align-end lims-num"><span className="lims-money">{nprText(r.amount)}</span></td>
              <td><StatusChip kind="payment_intent" status={r.status} /></td>
              <td>{reason(r)}</td>
            </tr>
          ))}
        </tbody>
        {intents.length === 0 ? <PlaceholderRows colSpan={HEADERS.length} /> : null}
      </table>
    </div></div>
  );

  const detail = sel ? (
    <>
      <h2>{reason(sel)}</h2>
      <Facts items={[
        ['Gateway', gatewayLabel(sel.gateway)],
        ['Amount', <span key="a" className="lims-money">{nprText(sel.amount)}</span>],
        ['Status', <StatusChip key="s" kind="payment_intent" status={sel.status} />],
        ['Reason', reason(sel)],
        ['Last checked', sel.last_checked_at ? <DateText key="c" value={sel.last_checked_at as Iso} withTime /> : '—'],
        ['Order', <a key="o" href={orderHref(sel)} aria-label={`Order ${sel.order_id.slice(0, 8)}`}><IdText value={sel.order_id} /></a>],
      ]} />
      <History events={[
        ['Created', sel.created_at] as const,
        ...(sel.last_checked_at ? [['Checked', sel.last_checked_at] as const] : []),
        ...(sel.settled_at ? [['Paid', sel.settled_at] as const] : []),
      ]} />
    </>
  ) : <p>Select a payment to see it here.</p>;

  return (
    <div ref={root}>
      <PageHeader title={t('payments.nav.review')} helpKey="payments.review" />
      <FilterBar filters={filters} value={value} onChange={go} onReset={() => router.push(BASE)} />
      <StatTileRow>
        <StatTile label="Under review" value={String(held.length)} />
        <StatTile label="Waiting for provider" value={String(intents.filter((r) => r.status === 'pending').length)} />
        <StatTile label="Oldest age" value={oldest(held.map(age))} />
      </StatTileRow>
      <ShortcutKey letter="O" run={sel ? () => router.push(intentHref(sel)) : undefined}>
        <SplitConsole list={list} detail={detail} listLabel="Payments needing review" detailLabel="Payment"
          actions={sel ? <a href={intentHref(sel)}>Open payment (O)</a> : undefined} />
      </ShortcutKey>
      {nextCursor || hasPrevious ? (
        <div className="lims-pager">
          <Button size="sm" variant="secondary" isDisabled={!hasPrevious} onPress={() => router.back()}>Previous</Button>
          <Button size="sm" variant="secondary" isDisabled={!nextCursor} onPress={() => nextCursor && go(value, nextCursor)}>Next</Button>
        </div>
      ) : null}
    </div>
  );
}
