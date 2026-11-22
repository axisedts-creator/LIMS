// T0D-ACCT-1 (LD-313; route staff.billing.account_summary): Account Summary of every party.
// T0D-UILIST-2 (LD-358): one list read (listAccountSummaries, GET /v1/billing/account-summaries); no getAccountSummary per party.
// T0D-BUILD-1 (LD-447): filters from the URL (checked by shape, bad values dropped), cursor paging. 501 operation_pending = NotAvailable with the header row (kept as a fallback);
// a 500 keeps title and filters (ErrorState in the table); a 400 (stale cursor, refused filter) keeps the screen with no rows and a warning.
import { t } from '@/core/i18n/messages';
import { pendingOr } from '@/core/shell/NotAvailable';
import { AccountSummaryScreen } from '@/features/billing/components/accounts/AccountSummaryScreen';
import { readList } from '@/features/billing/components/listRead';
import { listAccountSummaryRows, summaryFilters } from '@/features/billing/server/accounts.server';

// The header row (the screen is a client module, so the server page owns it and passes it down; NotAvailable repeats it).
const HEADERS = () => [
  t('billing.accounts.col.name'), t('billing.accounts.summary.col.kind'), `${t('billing.accounts.col.credit_limit')} (NPR)`, `${t('billing.accounts.col.outstanding')} (NPR)`,
  t('billing.accounts.col.side'), t('billing.accounts.col.blocked'),
];

export default async function AccountSummaryPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const f = summaryFilters((await searchParams) ?? {});
  return pendingOr(t('billing.accounts.summary.title'), HEADERS(), async () => {
    let refused = false;
    const { value, failure } = await readList(() => listAccountSummaryRows(f).catch((e: unknown) => {
      if ((e as { status?: number } | null)?.status === 400) { refused = true; return { data: [], page: { next_cursor: null } }; }
      throw e;
    }));
    return <AccountSummaryScreen headers={HEADERS()} rows={value?.data ?? []} nextCursor={value?.page?.next_cursor ?? undefined} filters={f} failure={failure} refused={refused} />;
  });
}
