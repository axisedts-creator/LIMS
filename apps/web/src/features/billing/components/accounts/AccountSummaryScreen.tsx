'use client';
// T0D-ACCT-1 (LD-313): billing/accounts/summary = ElabAssist Account Summary columns; each party links to its ledger.
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import type { AccountParty, AccountSummary } from '../../server/accounts.server';
import { formatNpr } from '../format';
import { typeText } from './accountsShared';

export interface AccountSummaryScreenProps { summaries: readonly AccountSummary[]; parties: readonly AccountParty[]; permissions: readonly string[] }

export function AccountSummaryScreen({ summaries, parties }: AccountSummaryScreenProps) {
  const party = (s: AccountSummary) => parties.find((p) => p.id === s.party_id && p.kind === s.party_kind);
  const text = (v: string | undefined) => v ?? '—';
  const columns: ColumnDef<AccountSummary>[] = [
    { id: 'center', header: t('billing.accounts.col.center'), cell: (s) => text(party(s)?.centre_name) },
    {
      id: 'name',
      header: t('billing.accounts.col.client_name'),
      cell: (s) => <a className="lims-link" href={`/billing/accounts/ledger?${new URLSearchParams({ party_kind: s.party_kind, party_id: s.party_id }).toString()}`}>{text(party(s)?.name)}</a>,
    },
    { id: 'franchise', header: t('billing.accounts.col.franchise'), cell: (s) => text(party(s)?.franchise_name) },
    { id: 'address', header: t('billing.accounts.col.address'), cell: (s) => text(party(s)?.address) },
    { id: 'joined', header: t('billing.accounts.col.joined'), cell: (s) => (party(s)?.joined_on ? <DateText value={party(s)!.joined_on as never} mode="AD_BS" /> : '—') },
    { id: 'contact_person', header: t('billing.accounts.col.contact_person'), cell: (s) => text(party(s)?.contact_person) },
    { id: 'contact_no', header: t('billing.accounts.col.contact_no'), cell: (s) => text(party(s)?.phone) },
    { id: 'email', header: t('billing.accounts.col.email'), cell: (s) => text(party(s)?.email) },
    { id: 'pan', header: t('billing.accounts.col.pan'), cell: (s) => text(party(s)?.pan) },
    { id: 'credit_limit', header: t('billing.accounts.col.credit_limit'), align: 'end', cell: (s) => formatNpr(s.credit_limit_paisa) },
    { id: 'outstanding', header: t('billing.accounts.col.outstanding'), align: 'end', cell: (s) => formatNpr(s.outstanding_paisa) },
    { id: 'side', header: t('billing.accounts.col.side'), cell: (s) => typeText(s.outstanding_side) },
    { id: 'blocked', header: t('billing.accounts.col.blocked'), cell: (s) => t(s.is_blocked ? 'billing.accounts.summary.yes' : 'billing.accounts.summary.no') },
  ];
  return (
    <section aria-label={t('billing.accounts.summary.title')}>
      <PageHeader title={t('billing.accounts.summary.title')} helpKey="billing.accounts" />
      <DataTable caption={t('billing.accounts.summary.title')} density="compact" columns={columns} rows={summaries} getRowId={(s) => `${s.party_kind}:${s.party_id}`} emptyState={{ title: t('billing.accounts.summary.empty') }} />
    </section>
  );
}
