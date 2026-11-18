'use client';
// T0D-ACCT-2 (LD-313, LD-310): ElabAssist Daily Payment Collection on billing/daily-cash = totals by payment mode for a centre and day, and the
// deposit entry (Save). A deposit records a debit on the centre pocket (party_kind user_pocket, party_id = centre) with the BANK_DEPOSIT particular,
// payment mode cash, entry date = the day. It only records: no money moves. A refund only day shows negative totals (LD-334).
import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { createAccountEntryAction } from '../../server/accounts.actions';
import type { AccountParticular, Named } from '../../server/accounts.server';
import type { DailyCollectionSummary } from '../../server/expenses.server';
import { errorText, formatNpr, hasPerm } from '../format';
import { GatedButton, ISO_DATE, modeText, newKey, toPaisa } from '../accounts/accountsShared';

const D = (k: string) => t(`billing.daily_summary.${k}`);
const CREATE = 'billing.account_entry.create';
const DEPOSIT_CODE = 'BANK_DEPOSIT';
type Row = DailyCollectionSummary['rows'][number];

export interface DailyCollectionScreenProps {
  summary: DailyCollectionSummary | null;
  centres: readonly Named[];
  centreId: string;
  day: string;
  particulars: readonly AccountParticular[];
  permissions: readonly string[];
}

export function DailyCollectionScreen({ summary, centres, centreId, day, particulars, permissions }: DailyCollectionScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [centre, setCentre] = useState(centreId);
  const [date, setDate] = useState(day);
  const [deposit, setDeposit] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const key = useRef(newKey());
  const bank = particulars.find((p) => p.code === DEPOSIT_CODE && p.is_active);
  const blocked = !hasPerm(permissions, CREATE) ? D('reason.no_create') : !bank ? D('reason.no_particular') : !centreId || !ISO_DATE.test(day) ? D('reason.no_centre')
    // Review fix: the deposit posts to the loaded summary (props), so unsearched Lab/Day edits must block Save (no entry on the wrong pocket).
    : centre !== centreId || date !== day ? D('reason.search_first') : undefined;

  const search = () => {
    const p = new URLSearchParams({ ...(centre ? { centre_id: centre } : {}), ...(ISO_DATE.test(date) ? { day: date } : {}) });
    router.push(`${pathname}?${p}`);
  };
  const save = async () => {
    if (inFlight.current || blocked) return;
    const paisa = toPaisa(deposit);
    if (paisa === undefined) return setError(t('billing.accounts.error.amount'));
    setError(undefined);
    inFlight.current = true;
    setPending(true);
    const r = await createAccountEntryAction(
      { centre_id: centreId, party_kind: 'user_pocket', party_id: centreId, entry_date: day, account_particular_id: bank!.id, entry_type: 'debit', amount_paisa: paisa, payment_mode: 'cash' },
      key.current,
    );
    inFlight.current = false;
    setPending(false);
    key.current = newKey();
    if (r.ok) { setDeposit(''); toast.show({ tone: 'success', title: D('saved') }); router.refresh(); }
    else toast.show({ tone: 'danger', title: D('failed'), description: errorText(r.code) });
  };

  const columns: ColumnDef<Row>[] = [
    // Trailing spaces: the row's text reads "Cash 2 NPR …", not "Cash2NPR" (copy, search and row lookups by word).
    { id: 'mode', header: D('col.mode'), isRowHeader: true, cell: (r) => `${modeText(r.payment_mode)} ` },
    { id: 'count', header: D('col.entries'), align: 'end', cell: (r) => `${r.entry_count} ` },
    { id: 'amount', header: D('col.amount'), align: 'end', cell: (r) => formatNpr(r.total_paisa) },
  ];
  return (
    <section aria-label={D('title')}>
      <PageHeader title={D('title')} helpKey="billing.accounts" />
      <div role="search" aria-label={D('filters')} className="lims-filter-bar">
        <Select label={D('col.lab')} name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...(centre ? { value: centre } : {})} onChange={setCentre} />
        <div className="lims-field">
          <label className="lims-label" htmlFor="daily-summary-day">{D('col.day')}</label>
          <input id="daily-summary-day" type="date" className="lims-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button variant="primary" onPress={search}>{D('search')}</Button>
      </div>
      <DataTable caption={D('title')} density="compact" columns={columns} rows={summary?.rows ?? []} getRowId={(r) => r.payment_mode} emptyState={{ title: D('empty') }} />
      {summary ? <p className="lims-inline"><span>{D('total')}</span><strong>{formatNpr(summary.total_paisa)}</strong></p> : null}
      <div className="lims-inline">
        <TextField label={D('deposit')} name="deposit" inputMode="decimal" maxLength={17} value={deposit} isDisabled={!!blocked} onChange={(v) => { setDeposit(v); setError(undefined); }} {...(error ? { error } : {})} />
        {blocked ? <GatedButton variant="primary" label={D('save')} blocked={blocked} onPress={() => undefined} /> : <Button variant="primary" isLoading={pending} onPress={() => void save()}>{D('save')}</Button>}
      </div>
    </section>
  );
}
