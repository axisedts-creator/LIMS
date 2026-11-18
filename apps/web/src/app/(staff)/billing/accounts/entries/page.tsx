// T0D-ACCT-1 (LD-313; route staff.billing.account_entries): View Account list + Account Entry form. Filters come from the URL (API query names;
// party = "<party_kind>:<party_id>"). ponytail: first 200 entries only (API limit); add cursor paging when a filter window holds more.
import { getShellSession } from '@/core/session/server';
import { AccountEntriesScreen } from '@/features/billing/components/accounts/AccountEntriesScreen';
import { readList } from '@/features/billing/components/listRead';
import { cleanFilters, listAccountLedgerEntries, listAccountParticulars, listAccountParties, listMembers } from '@/features/billing/server/accounts.server';
import { UUID_RE } from '@/features/billing/server/types';

const KEYS = ['centre_id', 'account_particular_id', 'entry_type', 'status', 'entry_date_from', 'entry_date_to'] as const;

export default async function AccountEntriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const f = cleanFilters(sp, KEYS);
  const m = typeof sp['party'] === 'string' ? /^(credit_party|franchise|user_pocket|laboratory):(.+)$/.exec(sp['party']) : null;
  const party = m && UUID_RE.test(m[2]!) ? { party_kind: m[1]!, party_id: m[2]! } : undefined;
  const members = await listMembers();
  // T0D-UILIST-2 (LD-353 rule 6): a 500 keeps the title and filters (ErrorState in the table); 4xx still go to the page's error handling.
  const [{ value: page, failure }, particulars, { parties, centres }] = await Promise.all([readList(() => listAccountLedgerEntries({ ...f, ...party })), listAccountParticulars(), listAccountParties(members)]);
  return (
    <AccountEntriesScreen
      entries={page?.data ?? []}
      failure={failure}
      particulars={particulars}
      parties={parties}
      centres={centres}
      members={members}
      permissions={session?.actor.permissions ?? []}
      filters={{ ...f, ...(party ? { party: `${party.party_kind}:${party.party_id}` } : {}) }}
    />
  );
}
