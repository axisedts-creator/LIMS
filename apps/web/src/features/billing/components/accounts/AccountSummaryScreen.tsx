'use client';
// T0D-ACCT-1 (LD-313): billing/accounts/summary = ElabAssist Account Summary columns; each party links to its ledger.
// T0D-UILIST-2 (LD-353 template 1, LD-358): one FilterBar with the party name search (`q` of listAccountSummaries), money right aligned with "(NPR)" in the header,
// a failed read (500) keeps the title and the filters with the ErrorState in the table body.
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import type { AccountParty, AccountSummary } from '../../server/accounts.server';
import { formatAmount } from '../format';
import type { ListFailure } from '../listRead';
import { LIST_FAILED, typeText } from './accountsShared';

/** Header row of the summary table (the page repeats it for its NotAvailable state while listAccountSummaries is pending). */
const summaryHeaders = () => [
  t('billing.accounts.col.center'), t('billing.accounts.col.client_name'), t('billing.accounts.col.franchise'), t('billing.accounts.col.address'), t('billing.accounts.col.joined'),
  t('billing.accounts.col.contact_person'), t('billing.accounts.col.contact_no'), t('billing.accounts.col.email'), t('billing.accounts.col.pan'),
  `${t('billing.accounts.col.credit_limit')} (NPR)`, `${t('billing.accounts.col.outstanding')} (NPR)`, t('billing.accounts.col.side'), t('billing.accounts.col.blocked'),
];

type Row = AccountSummary & { party_name?: string };
export interface AccountSummaryScreenProps { summaries: readonly Row[]; parties: readonly AccountParty[]; permissions: readonly string[]; failed?: number; truncated?: boolean; q?: string; failure?: ListFailure | undefined }

export function AccountSummaryScreen({ summaries, parties, failed = 0, truncated = false, q = '', failure }: AccountSummaryScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [f, setF] = useState<FilterValue>(q ? { q } : {});
  const party = (s: Row) => parties.find((p) => p.id === s.party_id && p.kind === s.party_kind);
  const text = (v: string | undefined) => v ?? '—';
  const h = summaryHeaders();
  const columns: ColumnDef<Row>[] = [
    { id: 'center', header: h[0]!, cell: (s) => text(party(s)?.centre_name) },
    {
      id: 'name',
      header: h[1]!,
      cell: (s) => <a className="lims-link" href={`/billing/accounts/ledger?${new URLSearchParams({ party_kind: s.party_kind, party_id: s.party_id }).toString()}`}>{text(party(s)?.name ?? s.party_name)}</a>,
    },
    { id: 'franchise', header: h[2]!, cell: (s) => text(party(s)?.franchise_name) },
    { id: 'address', header: h[3]!, cell: (s) => text(party(s)?.address) },
    { id: 'joined', header: h[4]!, cell: (s) => (party(s)?.joined_on ? <DateText value={party(s)!.joined_on as never} mode="AD_BS" /> : '—') },
    { id: 'contact_person', header: h[5]!, cell: (s) => text(party(s)?.contact_person) },
    { id: 'contact_no', header: h[6]!, cell: (s) => text(party(s)?.phone) },
    { id: 'email', header: h[7]!, cell: (s) => text(party(s)?.email) },
    { id: 'pan', header: h[8]!, cell: (s) => text(party(s)?.pan) },
    { id: 'credit_limit', header: h[9]!, numeric: true, cell: (s) => formatAmount(s.credit_limit_paisa) },
    { id: 'outstanding', header: h[10]!, numeric: true, cell: (s) => formatAmount(s.outstanding_paisa) },
    { id: 'side', header: h[11]!, cell: (s) => typeText(s.outstanding_side) },
    { id: 'blocked', header: h[12]!, cell: (s) => t(s.is_blocked ? 'billing.accounts.summary.yes' : 'billing.accounts.summary.no') },
  ];
  const search = (v: FilterValue) => {
    const s = typeof v['q'] === 'string' ? v['q'].trim() : '';
    router.push(s ? `${pathname}?${new URLSearchParams({ q: s }).toString()}` : pathname);
  };
  return (
    <section aria-label={t('billing.accounts.summary.title')}>
      <PageHeader title={t('billing.accounts.summary.title')} helpKey="billing.accounts" />
      <FilterBar
        filters={[{ id: 'q', kind: 'text', label: t('billing.accounts.col.client_name'), maxLength: 80 }]}
        value={f}
        onChange={setF}
        onSearch={() => search(f)}
        onReset={() => { setF({}); search({}); }}
      />
      {failed > 0 ? <Banner tone="warning" title={t('billing.accounts.summary.partial').replace('{n}', String(failed))} /> : null}
      {truncated ? <Banner tone="warning" title={t('billing.accounts.summary.truncated')} /> : null}
      <DataTable
        caption={t('billing.accounts.summary.title')}
        density="compact"
        columns={columns}
        rows={summaries}
        getRowId={(s) => `${s.party_kind}:${s.party_id}`}
        emptyState={{ title: t('billing.accounts.summary.empty') }}
        {...(failure ? { error: { title: LIST_FAILED, ...failure, onRetry: () => router.refresh() } } : {})}
      />
    </section>
  );
}
