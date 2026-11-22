'use client';
// T0D-ACCT-1 (LD-313): billing/accounts/summary; each party links to its ledger (the existing party account screen).
// T0D-UILIST-2 (LD-353 template 1, LD-358): one FilterBar, money right aligned with "(NPR)" in the header, a failed read (500) keeps title and filters (ErrorState in the table).
// T0D-BUILD-1 (LD-447): listAccountSummaries rows (name, kind, credit limit, outstanding, side, blocked tag), party kind select, name search, Blocked only / Outstanding only
// switches, a totals line for the page, Next / First page links. The filters live in the URL; a new search starts at page one (no cursor carried over).
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { t } from '@/core/i18n/messages';
import type { AccountSummaryRow, PartyKind, SummaryFilters } from '../../server/accounts.server';
import { formatAmount } from '../format';
import type { ListFailure } from '../listRead';
import { fill, LIST_FAILED, typeText } from './accountsShared';

const KIND_KEY: Readonly<Record<PartyKind, string>> = {
  credit_party: 'billing.accounts.col.client', franchise: 'billing.accounts.col.franchise', laboratory: 'billing.accounts.col.laboratory', user_pocket: 'billing.accounts.summary.kind.user_pocket',
};
const kindText = (k: PartyKind) => (Object.hasOwn(KIND_KEY, k) ? t(KIND_KEY[k]) : '—');

export interface AccountSummaryScreenProps {
  /** header row, built by the server page (it repeats it for its NotAvailable state). */
  headers: readonly string[];
  rows: readonly AccountSummaryRow[];
  nextCursor?: string | undefined;
  filters: SummaryFilters;
  failure?: ListFailure | undefined;
  /** the API refused the request (400: stale cursor or a filter it can not take). */
  refused?: boolean;
}

/** URL of this screen for the given filters (only set values; the switches only when on). */
const urlOf = (pathname: string, f: SummaryFilters) => {
  const p = new URLSearchParams();
  if (f.party_kind) p.set('party_kind', f.party_kind);
  if (f.q) p.set('q', f.q);
  if (f.blocked_only) p.set('blocked_only', 'true');
  if (f.outstanding_only) p.set('outstanding_only', 'true');
  if (f.cursor) p.set('cursor', f.cursor);
  const s = p.toString();
  return s ? `${pathname}?${s}` : pathname;
};

export function AccountSummaryScreen({ headers: h, rows, nextCursor, filters, failure, refused = false }: AccountSummaryScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [f, setF] = useState<FilterValue>({ ...(filters.party_kind ? { party_kind: filters.party_kind } : {}), ...(filters.q ? { q: filters.q } : {}) });
  const [blocked, setBlocked] = useState(filters.blocked_only === true);
  const [outstanding, setOutstanding] = useState(filters.outstanding_only === true);
  const firstPage: SummaryFilters = { ...filters, cursor: undefined };
  const columns: ColumnDef<AccountSummaryRow>[] = [
    {
      id: 'name',
      header: h[0]!,
      isRowHeader: true,
      cell: (s) => <a className="lims-link" href={`/billing/accounts/ledger?${new URLSearchParams({ party_kind: s.party_kind, party_id: s.party_id }).toString()}`}>{s.party_name}</a>,
    },
    { id: 'kind', header: h[1]!, cell: (s) => kindText(s.party_kind) },
    { id: 'credit_limit', header: h[2]!, numeric: true, cell: (s) => formatAmount(s.credit_limit_paisa) },
    { id: 'outstanding', header: h[3]!, numeric: true, cell: (s) => formatAmount(s.outstanding_paisa) },
    { id: 'side', header: h[4]!, cell: (s) => typeText(s.outstanding_side) },
    { id: 'blocked', header: h[5]!, cell: (s) => (s.is_blocked ? <Badge tone="danger">{t('billing.accounts.summary.blocked_tag')}</Badge> : '—') },
  ];
  const go = (v: FilterValue, b: boolean, o: boolean) => {
    const kind = typeof v['party_kind'] === 'string' ? (v['party_kind'] as PartyKind) : undefined;
    const q = typeof v['q'] === 'string' ? v['q'].trim().slice(0, 80) : '';
    router.push(urlOf(pathname, { ...(kind ? { party_kind: kind } : {}), ...(q ? { q } : {}), ...(b ? { blocked_only: true } : {}), ...(o ? { outstanding_only: true } : {}) }));
  };
  // ponytail: the totals cover the rows of this page only (integer paisa, debit minus credit); a tenant-wide total needs its own operation.
  const sumLimit = rows.reduce((s, r) => s + r.credit_limit_paisa, 0);
  const net = rows.reduce((s, r) => s + (r.outstanding_side === 'debit' ? r.outstanding_paisa : -r.outstanding_paisa), 0);
  return (
    <section aria-label={t('billing.accounts.summary.title')}>
      <PageHeader title={t('billing.accounts.summary.title')} helpKey="billing.accounts" />
      <FilterBar
        filters={[
          { id: 'party_kind', kind: 'select', label: t('billing.accounts.summary.kind_filter'), options: (Object.keys(KIND_KEY) as PartyKind[]).map((k) => ({ value: k, label: kindText(k) })) },
          { id: 'q', kind: 'text', label: t('billing.accounts.col.name'), maxLength: 80, search: true },
        ]}
        value={f}
        onChange={setF}
        onSearch={() => go(f, blocked, outstanding)}
        onReset={() => { setF({}); setBlocked(false); setOutstanding(false); go({}, false, false); }}
      >
        <Switch label={t('billing.accounts.summary.blocked_only')} isSelected={blocked} onChange={(on) => { setBlocked(on); go(f, on, outstanding); }} />
        <Switch label={t('billing.accounts.summary.outstanding_only')} isSelected={outstanding} onChange={(on) => { setOutstanding(on); go(f, blocked, on); }} />
      </FilterBar>
      {refused ? <Banner tone="warning" title={t('billing.accounts.summary.refused')} /> : null}
      <DataTable
        caption={t('billing.accounts.summary.title')}
        density="compact"
        columns={columns}
        rows={rows}
        getRowId={(s) => `${s.party_kind}:${s.party_id}`}
        emptyState={{ title: t('billing.accounts.summary.empty') }}
        {...(failure ? { error: { title: LIST_FAILED, ...failure, onRetry: () => router.refresh() } } : {})}
      />
      {rows.length > 0 ? (
        <p className="lims-table-total">
          {fill('billing.accounts.summary.total', { limit: formatAmount(sumLimit), outstanding: formatAmount(Math.abs(net)), side: typeText(net < 0 ? 'credit' : 'debit') })}
        </p>
      ) : null}
      <nav aria-label={t('billing.accounts.summary.pages')} className="lims-inline">
        {filters.cursor ? <a className="lims-link" href={urlOf(pathname, firstPage)}>{t('billing.accounts.summary.first_page')}</a> : null}
        {nextCursor ? <a className="lims-link" href={urlOf(pathname, { ...firstPage, cursor: nextCursor })}>{t('billing.accounts.summary.next_page')}</a> : null}
      </nav>
    </section>
  );
}
