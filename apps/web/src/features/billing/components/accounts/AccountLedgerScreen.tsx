'use client';
// T0D-ACCT-1 (LD-313): billing/accounts/ledger = party ledger statement (getAccountStatement): opening balance, rows with the server's running
// balance, closing balance, totals; print and CSV. Account Ledger could not be read in ElabAssist (LD-313 e): shape = standard ledger practice.
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { t } from '@/core/i18n/messages';
import type { AccountParticular, AccountParty, AccountStatement, AccountStatementRow, EntryType } from '../../server/accounts.server';
import { formatNpr } from '../format';
import { GatedButton, ISO_DATE, downloadCsv, fill, nameOf, plainRupees, sideText, statusText } from './accountsShared';

const balance = (paisa: number, side: EntryType) => `${formatNpr(paisa)} ${sideText(side)}`;

function statementColumns(statement: AccountStatement | null, particulars: readonly AccountParticular[]): ColumnDef<AccountStatementRow>[] {
  const receiptOf = (id: string) => statement?.rows.find((r) => r.entry_id === id)?.receipt_no;
  return [
    { id: 'date', header: t('billing.accounts.col.date'), cell: (r) => <DateText value={r.entry_date as never} mode="AD_BS" /> },
    { id: 'particulars', header: t('billing.accounts.col.particulars'), cell: (r) => nameOf(particulars, r.account_particular_id) },
    {
      id: 'status',
      header: t('billing.accounts.col.status'),
      cell: (r) => (r.reverses_entry_id ? `${statusText(r.status)} · ${receiptOf(r.reverses_entry_id) ? fill('billing.accounts.entries.reverses', { no: receiptOf(r.reverses_entry_id)! }) : t('billing.accounts.entries.reversal')}` : statusText(r.status)),
    },
    { id: 'credit', header: t('billing.accounts.col.credit'), align: 'end', cell: (r) => (r.credit_paisa ? formatNpr(r.credit_paisa) : '') },
    { id: 'debit', header: t('billing.accounts.col.debit'), align: 'end', cell: (r) => (r.debit_paisa ? formatNpr(r.debit_paisa) : '') },
    { id: 'balance', header: t('billing.accounts.col.balance'), align: 'end', cell: (r) => balance(r.balance_paisa, r.balance_side) },
    // Row header (react-aria needs one); last so the money cells keep their grid positions.
    { id: 'receipt', header: t('billing.accounts.col.receipt_no'), isRowHeader: true, cell: (r) => r.receipt_no },
  ];
}

type Line = { id: string; label: string; paisa: number; side?: EntryType };
const lines = (s: AccountStatement): Line[] => [
  { id: 'opening', label: t('billing.accounts.ledger.opening'), paisa: s.opening_balance_paisa, side: s.opening_balance_side },
  { id: 'total_credit', label: t('billing.accounts.ledger.total_credit'), paisa: s.total_credit_paisa },
  { id: 'total_debit', label: t('billing.accounts.ledger.total_debit'), paisa: s.total_debit_paisa },
  { id: 'closing', label: t('billing.accounts.ledger.closing'), paisa: s.closing_balance_paisa, side: s.closing_balance_side },
];
const lineColumns: ColumnDef<Line>[] = [
  { id: 'line', header: t('billing.accounts.col.line'), isRowHeader: true, cell: (l) => l.label },
  { id: 'amount', header: t('billing.accounts.col.amount'), align: 'end', cell: (l) => formatNpr(l.paisa) },
  { id: 'side', header: t('billing.accounts.col.dr_cr'), cell: (l) => (l.side ? sideText(l.side) : '') },
];

function StatementTables({ statement, particulars, emptyText }: { statement: AccountStatement | null; particulars: readonly AccountParticular[]; emptyText: string }) {
  return (
    <>
      <DataTable caption={t('billing.accounts.ledger.rows')} density="compact" columns={statementColumns(statement, particulars)} rows={statement?.rows ?? []} getRowId={(r) => r.entry_id} emptyState={{ title: emptyText }} />
      {statement ? <DataTable caption={t('billing.accounts.ledger.balances')} density="compact" columns={lineColumns} rows={lines(statement)} getRowId={(l) => l.id} emptyState={{ title: '' }} /> : null}
    </>
  );
}

/** Ledger rows + balances with Print and CSV; shared by the party ledger and the pocket ledger. */
export function StatementView({ statement, particulars, title, emptyText }: { statement: AccountStatement | null; particulars: readonly AccountParticular[]; title: string; emptyText: string }) {
  const [printing, setPrinting] = useState(false);
  const blocked = statement ? undefined : t('billing.accounts.reason.pick_party_first');
  const exportCsv = () => {
    if (!statement) return;
    const head = [t('billing.accounts.col.date'), t('billing.accounts.col.receipt_no'), t('billing.accounts.col.particulars'), t('billing.accounts.col.status'), t('billing.accounts.col.credit'), t('billing.accounts.col.debit'), t('billing.accounts.col.balance'), t('billing.accounts.col.dr_cr')];
    const money = (p: number) => (p ? plainRupees(p) : '');
    const rows = [
      head,
      [statement.from, '', t('billing.accounts.ledger.opening'), '', '', '', plainRupees(statement.opening_balance_paisa), sideText(statement.opening_balance_side)],
      ...statement.rows.map((r) => [r.entry_date, r.receipt_no, nameOf(particulars, r.account_particular_id), statusText(r.status), money(r.credit_paisa), money(r.debit_paisa), plainRupees(r.balance_paisa), sideText(r.balance_side)]),
      ['', '', t('billing.accounts.ledger.total_credit'), '', plainRupees(statement.total_credit_paisa), '', '', ''],
      ['', '', t('billing.accounts.ledger.total_debit'), '', '', plainRupees(statement.total_debit_paisa), '', ''],
      [statement.to, '', t('billing.accounts.ledger.closing'), '', '', '', plainRupees(statement.closing_balance_paisa), sideText(statement.closing_balance_side)],
    ];
    downloadCsv(`ledger-${statement.party_kind}-${statement.from}-${statement.to}.csv`, rows);
  };
  return (
    <>
      <div className="lims-inline" role="group" aria-label={title}>
        <GatedButton label={t('billing.accounts.ledger.print')} blocked={blocked} reasonId="acct-statement-reason" onPress={() => setPrinting(true)} />
        <GatedButton label={t('billing.accounts.ledger.csv')} blocked={blocked} reasonId="acct-statement-reason" onPress={exportCsv} />
        {blocked ? <span id="acct-statement-reason" className="lims-description">{blocked}</span> : null}
      </div>
      <StatementTables statement={statement} particulars={particulars} emptyText={emptyText} />
      {printing && statement ? (
        <PrintFrame title={title} isOpen onDone={() => setPrinting(false)}>
          <h2>{title}</h2>
          <StatementTables statement={statement} particulars={particulars} emptyText={emptyText} />
        </PrintFrame>
      ) : null}
    </>
  );
}

export interface AccountLedgerScreenProps {
  statement: AccountStatement | null;
  party: AccountParty | null;
  parties: readonly AccountParty[];
  from: string;
  to: string;
  particulars: readonly AccountParticular[];
  permissions: readonly string[];
}

export function AccountLedgerScreen({ statement, party, parties, from, to, particulars }: AccountLedgerScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pick, setPick] = useState(party ? `${party.kind}:${party.id}` : '');
  const [range, setRange] = useState({ from, to });
  const show = (p = pick) => {
    const [kind, id] = p.split(':');
    if (!kind || !id || !ISO_DATE.test(range.from) || !ISO_DATE.test(range.to)) return;
    router.push(`${pathname}?${new URLSearchParams({ party_kind: kind, party_id: id, from: range.from, to: range.to }).toString()}`);
  };
  const title = fill('billing.accounts.ledger.print_title', { party: party?.name ?? '' });
  return (
    <section aria-label={t('billing.accounts.ledger.title')}>
      <PageHeader title={t('billing.accounts.ledger.title')} helpKey="billing.accounts" />
      <div role="search" aria-label={t('billing.accounts.ledger.filters')} className="lims-filter-bar">
        <Select label={t('billing.accounts.ledger.party')} name="party" options={parties.filter((p) => p.kind !== 'user_pocket').map((p) => ({ value: `${p.kind}:${p.id}`, label: p.name }))} {...(pick ? { value: pick } : {})} onChange={(v) => { setPick(v); show(v); }} />
        <TextField label={t('billing.accounts.filter.from')} name="from" maxLength={10} description={t('billing.accounts.field.date_hint')} value={range.from} onChange={(v) => setRange((r) => ({ ...r, from: v }))} />
        <TextField label={t('billing.accounts.filter.to')} name="to" maxLength={10} value={range.to} onChange={(v) => setRange((r) => ({ ...r, to: v }))} />
        <Button variant="primary" onPress={() => show()}>{t('billing.accounts.ledger.show')}</Button>
      </div>
      <StatementView statement={statement} particulars={particulars} title={title} emptyText={t(statement ? 'billing.accounts.ledger.empty' : 'billing.accounts.ledger.pick_party')} />
    </section>
  );
}
