'use client';
// T0D-ACCT-1 (LD-313): billing/accounts/pocket = the signed in user's pocket ledger (party_kind user_pocket). Other users' pockets need
// billing.account.manage [CONV: no new permission code]; without it there is no owner picker and another owner's rows are never shown.
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Select } from '@lims/ui/components/Select';
import { t } from '@/core/i18n/messages';
import type { AccountParticular, AccountStatement, Named } from '../../server/accounts.server';
import { hasPerm } from '../format';
import type { ListFailure } from '../listRead';
import { ISO_DATE, PERM, fill, nameOf } from './accountsShared';
import { DateFields, StatementView } from './AccountLedgerScreen';

export interface PocketLedgerScreenProps {
  statement: AccountStatement | null;
  ownerId: string;
  currentMembershipId: string;
  owners: readonly Named[];
  from: string;
  to: string;
  particulars: readonly AccountParticular[];
  permissions: readonly string[];
  failure?: ListFailure | undefined;
}

export function PocketLedgerScreen({ statement, ownerId, currentMembershipId, owners, from, to, particulars, permissions, failure }: PocketLedgerScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const canSeeOthers = hasPerm(permissions, PERM.manage);
  const mine = ownerId === currentMembershipId;
  const allowed = mine || canSeeOthers;
  const [owner, setOwner] = useState(ownerId);
  const [range, setRange] = useState({ from, to });
  const show = (o = owner) => {
    if (!ISO_DATE.test(range.from) || !ISO_DATE.test(range.to)) return;
    const q = new URLSearchParams({ ...(o && o !== currentMembershipId ? { owner_id: o } : {}), from: range.from, to: range.to });
    router.push(`${pathname}?${q.toString()}`);
  };
  const heading = mine ? t('billing.accounts.pocket.mine') : fill('billing.accounts.pocket.of', { name: allowed ? nameOf(owners, ownerId) : '' });
  return (
    <section aria-label={t('billing.accounts.pocket.title')}>
      <StatementView
        pageTitle={t('billing.accounts.pocket.title')}
        statement={allowed ? statement : null}
        particulars={particulars}
        title={heading}
        failure={failure}
        emptyText={t(statement ? 'billing.accounts.ledger.empty' : 'billing.accounts.pocket.unavailable')}
        filters={
          <>
            <h2>{heading}</h2>
            <div role="search" aria-label={t('billing.accounts.ledger.filters')} className="lims-filter-bar">
              {canSeeOthers ? <Select label={t('billing.accounts.pocket.owner')} name="owner_id" options={owners.map((o) => ({ value: o.id, label: o.name }))} {...(owner ? { value: owner } : {})} onChange={(v) => { setOwner(v); show(v); }} /> : null}
              <DateFields range={range} setRange={setRange} />
              <Button variant="primary" onPress={() => show()}>{t('billing.accounts.ledger.show')}</Button>
            </div>
          </>
        }
        {...(allowed ? {} : { body: <Banner tone="warning" title={t('billing.accounts.pocket.not_allowed')} /> })}
      />
    </section>
  );
}
