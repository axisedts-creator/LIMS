// T0D-ACCT-1 (LD-313; route staff.billing.account_entries): View Account list + Account Entry form. Filters come from the URL (API query names;
// party = "<party_kind>:<party_id>"). ponytail: first 200 entries only (API limit); add cursor paging when a filter window holds more.
import { getShellSession } from '@/core/session/server';
import { AccountEntriesScreen } from '@/features/billing/components/accounts/AccountEntriesScreen';
import { cleanFilters, listAccountLedgerEntries, listAccountParticulars, listAccountParties, listMembers } from '@/features/billing/server/accounts.server';
import { UUID_RE } from '@/features/billing/server/types';

const KEYS = ['centre_id', 'account_particular_id', 'entry_type', 'status', 'entry_date_from', 'entry_date_to'] as const;

export default async function AccountEntriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const f = cleanFilters(sp, KEYS);
  const m = typeof sp['party'] === 'string' ? /^(credit_party|franchise|user_pocket|laboratory):(.+)$/.exec(sp['party']) : null;
  const party = m && UUID_RE.test(m[2]!) ? { party_kind: m[1]!, party_id: m[2]! } : undefined;
  const members = await listMembers();
  const [page, particulars, { parties, centres }] = await Promise.all([listAccountLedgerEntries({ ...f, ...party }), listAccountParticulars(), listAccountParties(members)]);
  return (
    <AccountEntriesScreen
      entries={page.data ?? []}
      particulars={particulars}
      parties={parties}
      centres={centres}
      members={members}
      permissions={session?.actor.permissions ?? []}
      filters={{ ...f, ...(party ? { party: `${party.party_kind}:${party.party_id}` } : {}) }}
    />
  );
}
