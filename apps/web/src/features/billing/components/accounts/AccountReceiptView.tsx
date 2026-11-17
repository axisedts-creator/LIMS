'use client';
// T0D-ACCT-1 (LD-313): printable account receipt (records only, no money moves; not a fiscal document). Dates A.D. with B.S. beside.
import type { ReactNode } from 'react';
import { DateText } from '@lims/ui/components/DateText';
import { t } from '@/core/i18n/messages';
import type { AccountLedgerEntry, AccountParticular, AccountParty, Named } from '../../server/accounts.server';
import { amountInWords, formatNpr } from '../format';
import { fill, modeText, statusText, typeText } from './accountsShared';

export function AccountReceiptView({ entry: e, party, particular, centre }: { entry: AccountLedgerEntry; party?: AccountParty | undefined; particular?: AccountParticular | undefined; centre?: Named | undefined }) {
  const row = (key: string, value: ReactNode) => (value === undefined || value === '' ? null : <><dt>{t(key)}</dt><dd>{value}</dd></>);
  return (
    <article className="lims-receipt-doc" aria-label={fill('billing.accounts.receipt.label', { no: e.receipt_no })}>
      <h2>{t('billing.accounts.receipt.heading')}</h2>
      <dl>
        {row('billing.accounts.receipt.no', e.receipt_no)}
        {row('billing.accounts.receipt.date', <DateText value={e.entry_date as never} mode="AD_BS" />)}
        {row('billing.accounts.field.laboratory', centre?.name ?? '—')}
        {row('billing.accounts.receipt.party', party?.name ?? '—')}
        {row('billing.accounts.field.particulars', particular?.name ?? '—')}
        {row('billing.accounts.field.type', typeText(e.entry_type))}
        {row('billing.accounts.receipt.amount', formatNpr(e.amount_paisa))}
        {row('billing.accounts.receipt.in_words', amountInWords(e.amount_paisa))}
        {row('billing.accounts.field.payment_mode', modeText(e.payment_mode))}
        {row('billing.accounts.field.bank', e.bank_name)}
        {row('billing.accounts.field.reference', e.reference_no)}
        {row('billing.accounts.field.payment_details', e.payment_details)}
        {row('billing.accounts.field.comments', e.comments)}
        {row('billing.accounts.col.status', statusText(e.status))}
      </dl>
      {e.status === 'reversed' ? <p>{t('billing.accounts.receipt.reversed_note')}</p> : null}
    </article>
  );
}
