// T0D-ACCT-1 (LD-313; route staff.billing.account_summary): Account Summary of every client and franchise.
// T0D-UILIST-2 (LD-358): one list read (listAccountSummaries, GET /v1/billing/account-summaries) with the name search `q`; no getAccountSummary per party.
// 501 operation_pending (no handler until T0B-ACCTLIST-1) = NotAvailable with the header row; a 500 keeps title and filters (ErrorState in the table).
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { pendingOr } from '@/core/shell/NotAvailable';
import { AccountSummaryScreen } from '@/features/billing/components/accounts/AccountSummaryScreen';
import { readList } from '@/features/billing/components/listRead';
import { listAccountParties, listAccountSummaryRows } from '@/features/billing/server/accounts.server';

// Same header row as AccountSummaryScreen (a client module, so the server page can not import its helper).
const HEADERS = () => [
  ...['center', 'client_name', 'franchise', 'address', 'joined', 'contact_person', 'contact_no', 'email', 'pan'].map((k) => t(`billing.accounts.col.${k}`)),
  `${t('billing.accounts.col.credit_limit')} (NPR)`, `${t('billing.accounts.col.outstanding')} (NPR)`, t('billing.accounts.col.side'), t('billing.accounts.col.blocked'),
];

export default async function AccountSummaryPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = (await searchParams) ?? {};
  const q = typeof sp['q'] === 'string' ? sp['q'].slice(0, 80) : '';
  return pendingOr(t('billing.accounts.summary.title'), HEADERS(), async () => {
    const [session, { parties }, { value, failure }] = await Promise.all([getShellSession(), listAccountParties(), readList(() => listAccountSummaryRows({ q }))]);
    return <AccountSummaryScreen summaries={value?.data ?? []} failure={failure} q={q} parties={parties} permissions={session?.actor.permissions ?? []} />;
  });
}
