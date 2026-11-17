'use client';
// T0D-ACCT-1 (LD-313, LD-310; founder 2026-11-17 04:49 / 04:57 NPT): billing/accounts/entries = ElabAssist View Account list + Account Entry form.
// Append only (LD-313 b): an entry is never edited or deleted; the only correction is Reverse, which asks for a reason.
import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { createAccountEntryAction, reverseAccountEntryAction } from '../../server/accounts.actions';
import type { AccountLedgerEntry, AccountParticular, AccountParty, CreateEntryInput, EntryType, Named } from '../../server/accounts.server';
import { errorText, formatNpr, hasPerm } from '../format';
import { AccountReceiptView } from './AccountReceiptView';
import { BANK_MODES, GatedButton, ISO_DATE, LabelOnlySelect, LONG_DIGITS, PAYMENT_MODES, PERM, fill, modeText, nameOf, newKey, statusText, toPaisa, typeText } from './accountsShared';

const FILTER_KEYS = ['centre_id', 'party', 'account_particular_id', 'entry_type', 'status', 'entry_date_from', 'entry_date_to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

export interface AccountEntriesScreenProps {
  entries: readonly AccountLedgerEntry[];
  particulars: readonly AccountParticular[];
  parties: readonly AccountParty[];
  centres: readonly Named[];
  members: readonly Named[];
  permissions: readonly string[];
  /** Current URL filters (API query names; party = "<party_kind>:<party_id>"). */
  filters?: Filters;
}

export function AccountEntriesScreen({ entries, particulars, parties, centres, members, permissions, filters = {} }: AccountEntriesScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [f, setF] = useState<Filters>(filters);
  const [creating, setCreating] = useState(false);
  const [reversing, setReversing] = useState<AccountLedgerEntry | null>(null);
  const [printing, setPrinting] = useState<AccountLedgerEntry | null>(null);
  const canCreate = hasPerm(permissions, PERM.create);
  const canReverse = hasPerm(permissions, PERM.reverse);

  const apply = (next: Filters) => {
    setF(next);
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (next[k]) p.set(k, next[k]!);
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  };
  const setNow = (k: FilterKey) => (v: string) => apply({ ...f, [k]: v });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const partyName = (e: AccountLedgerEntry) => nameOf(parties, e.party_id);
  const reverseBlock = (e: AccountLedgerEntry) =>
    !canReverse ? t('billing.accounts.reason.no_reverse')
      : e.status === 'reversed' ? t('billing.accounts.reason.already_reversed')
        : e.reverses_entry_id ? t('billing.accounts.reason.is_reversal') : undefined;

  const columns: ColumnDef<AccountLedgerEntry>[] = [
    { id: 'laboratory', header: t('billing.accounts.col.laboratory'), cell: (e) => nameOf(centres, e.centre_id) },
    { id: 'client', header: t('billing.accounts.col.client'), cell: (e) => (e.party_kind === 'franchise' ? '' : partyName(e)) },
    { id: 'franchise', header: t('billing.accounts.col.franchise'), cell: (e) => (e.party_kind === 'franchise' ? partyName(e) : '') },
    { id: 'entry_date', header: t('billing.accounts.col.entry_date'), cell: (e) => <DateText value={e.entry_date as never} mode="AD_BS" /> },
    { id: 'particulars', header: t('billing.accounts.col.particulars'), cell: (e) => nameOf(particulars, e.account_particular_id) },
    { id: 'credited', header: t('billing.accounts.col.credited'), align: 'end', cell: (e) => (e.entry_type === 'credit' ? formatNpr(e.amount_paisa) : '') },
    { id: 'debited', header: t('billing.accounts.col.debited'), align: 'end', cell: (e) => (e.entry_type === 'debit' ? formatNpr(e.amount_paisa) : '') },
    { id: 'comments', header: t('billing.accounts.col.comments'), cell: (e) => e.comments ?? '' },
    { id: 'payment_mode', header: t('billing.accounts.col.payment_mode'), cell: (e) => modeText(e.payment_mode) },
    { id: 'reference_no', header: t('billing.accounts.col.reference_no'), cell: (e) => e.reference_no ?? '' },
    { id: 'bank', header: t('billing.accounts.col.bank'), cell: (e) => e.bank_name ?? '' },
    { id: 'payment_details', header: t('billing.accounts.col.payment_details'), cell: (e) => e.payment_details ?? '' },
    { id: 'last_modified_by', header: t('billing.accounts.col.last_modified_by'), cell: (e) => nameOf(members, e.last_modified_by) },
    {
      id: 'status',
      header: t('billing.accounts.col.entry_status'),
      cell: (e) => (
        <span className="lims-inline">
          <span>{statusText(e.status)}</span>
          {e.reverses_entry_id ? <span>{byId.get(e.reverses_entry_id) ? fill('billing.accounts.entries.reverses', { no: byId.get(e.reverses_entry_id)!.receipt_no }) : t('billing.accounts.entries.reversal')}</span> : null}
          <GatedButton label={t('billing.accounts.entries.reverse')} blocked={reverseBlock(e)} onPress={() => setReversing(e)} />
        </span>
      ),
    },
    {
      id: 'receipt',
      header: t('billing.accounts.col.receipt'),
      isRowHeader: true, // the receipt number names the row; last column so the other cells keep their grid positions
      cell: (e) => (
        <span className="lims-inline">
          <span>{e.receipt_no}</span>
          <Button size="sm" variant="ghost" onPress={() => setPrinting(e)}>{t('billing.accounts.receipt.download')}</Button>
        </span>
      ),
    },
  ];

  const partyOptions = parties.filter((p) => p.kind !== 'user_pocket').map((p) => ({ value: `${p.kind}:${p.id}`, label: p.name }));
  const opt = (k: FilterKey) => (f[k] ? { value: f[k]! } : {});
  return (
    <section aria-label={t('billing.accounts.entries.title')}>
      <PageHeader
        title={t('billing.accounts.entries.title')}
        helpKey="billing.accounts"
        actions={<GatedButton variant="primary" label={t('billing.accounts.entries.new')} blocked={canCreate ? undefined : t('billing.accounts.reason.no_create')} onPress={() => setCreating(true)} />}
      />
      <div role="search" aria-label={t('billing.accounts.entries.filters')} className="lims-filter-bar">
        <Select label={t('billing.accounts.filter.centre')} name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...opt('centre_id')} onChange={setNow('centre_id')} />
        <Select label={t('billing.accounts.filter.party')} name="party" options={partyOptions} {...opt('party')} onChange={setNow('party')} />
        <Select label={t('billing.accounts.filter.particular')} name="account_particular_id" options={particulars.map((p) => ({ value: p.id, label: p.name }))} {...opt('account_particular_id')} onChange={setNow('account_particular_id')} />
        <Select label={t('billing.accounts.filter.type')} name="entry_type" options={(['credit', 'debit'] as const).map((v) => ({ value: v, label: typeText(v) }))} {...opt('entry_type')} onChange={setNow('entry_type')} />
        <Select label={t('billing.accounts.filter.status')} name="status" options={(['submitted', 'approved', 'rejected', 'reversed'] as const).map((v) => ({ value: v, label: statusText(v) }))} {...opt('status')} onChange={setNow('status')} />
        <TextField label={t('billing.accounts.filter.from')} name="entry_date_from" maxLength={10} description={t('billing.accounts.field.date_hint')} value={f.entry_date_from ?? ''} onChange={(v) => setF({ ...f, entry_date_from: v })} />
        <TextField label={t('billing.accounts.filter.to')} name="entry_date_to" maxLength={10} value={f.entry_date_to ?? ''} onChange={(v) => setF({ ...f, entry_date_to: v })} />
        <Button variant="primary" onPress={() => apply(Object.fromEntries(Object.entries(f).filter(([k, v]) => !k.startsWith('entry_date') || ISO_DATE.test(v ?? ''))))}>{t('billing.accounts.filter.search')}</Button>
        <Button variant="ghost" onPress={() => apply({})}>{t('billing.accounts.filter.reset')}</Button>
      </div>
      <DataTable caption={t('billing.accounts.entries.list')} density="compact" columns={columns} rows={entries} getRowId={(e) => e.id} emptyState={{ title: t('billing.accounts.entries.empty') }} />

      {creating ? (
        <EntryDialog
          centres={centres}
          parties={parties}
          particulars={particulars.filter((p) => p.is_active)}
          onClose={() => setCreating(false)}
          onSearch={(next) => { setCreating(false); apply(next); }}
          onDone={(no) => { setCreating(false); toast.show({ tone: 'success', title: fill('billing.accounts.entries.saved', { no }) }); router.refresh(); }}
          onFail={(code) => toast.show({ tone: 'danger', title: t('billing.accounts.entries.failed'), description: errorText(code) })}
        />
      ) : null}
      {reversing ? (
        <ReverseDialog
          entry={reversing}
          onClose={() => setReversing(null)}
          onDone={() => { setReversing(null); toast.show({ tone: 'success', title: t('billing.accounts.entries.reversed_ok') }); router.refresh(); }}
          onFail={(code) => toast.show({ tone: 'danger', title: t('billing.accounts.entries.reverse_failed'), description: errorText(code) })}
        />
      ) : null}
      {printing ? (
        <PrintFrame title={fill('billing.accounts.receipt.label', { no: printing.receipt_no })} isOpen onDone={() => setPrinting(null)}>
          <AccountReceiptView entry={printing} party={parties.find((p) => p.id === printing.party_id)} particular={particulars.find((p) => p.id === printing.account_particular_id)} centre={centres.find((c) => c.id === printing.centre_id)} />
        </PrintFrame>
      ) : null}
    </section>
  );
}

type Draft = { centre_id?: string; client?: string | undefined; franchise?: string | undefined; entry_date: string; account_particular_id?: string; entry_type?: EntryType; amount: string; payment_mode?: string; bank_name: string; reference_no: string; payment_details: string; comments: string };

function EntryDialog({ centres, parties, particulars, onClose, onSearch, onDone, onFail }: { centres: readonly Named[]; parties: readonly AccountParty[]; particulars: readonly AccountParticular[]; onClose: () => void; onSearch: (f: Filters) => void; onDone: (receiptNo: string) => void; onFail: (code: string) => void }) {
  const [d, setD] = useState<Draft>({ entry_date: '', amount: '', bank_name: '', reference_no: '', payment_details: '', comments: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof Draft | 'party', string>>>({});
  const key = useRef(newKey());
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const opts = (kind: AccountParty['kind']) => parties.filter((p) => p.kind === kind).map((p) => ({ value: p.id, label: p.name }));

  const submit = async () => {
    const req = t('billing.accounts.error.required');
    const amount = toPaisa(d.amount);
    const e: typeof errors = {};
    if (!d.centre_id) e.centre_id = req;
    if (!d.client && !d.franchise) e.party = t('billing.accounts.error.party');
    if (!ISO_DATE.test(d.entry_date)) e.entry_date = t('billing.accounts.error.date');
    if (!d.account_particular_id) e.account_particular_id = req;
    if (!d.entry_type) e.entry_type = req;
    if (amount === undefined) e.amount = t('billing.accounts.error.amount');
    if (!d.payment_mode) e.payment_mode = req;
    if (d.payment_mode && BANK_MODES.includes(d.payment_mode) && !d.bank_name.trim()) e.bank_name = t('billing.accounts.error.bank');
    if (LONG_DIGITS.test(d.reference_no)) e.reference_no = t('billing.accounts.error.no_long_digits');
    if (LONG_DIGITS.test(d.payment_details)) e.payment_details = t('billing.accounts.error.no_long_digits');
    setErrors(e);
    if (Object.keys(e).length) return;
    const trimmed = (v: string) => (v.trim() ? v.trim() : undefined);
    const optional = { bank_name: trimmed(d.bank_name), reference_no: trimmed(d.reference_no), payment_details: trimmed(d.payment_details), comments: trimmed(d.comments) };
    const body: CreateEntryInput = {
      centre_id: d.centre_id!, party_kind: d.client ? 'credit_party' : 'franchise', party_id: (d.client ?? d.franchise)!, entry_date: d.entry_date,
      account_particular_id: d.account_particular_id!, entry_type: d.entry_type!, amount_paisa: amount!, payment_mode: d.payment_mode!,
      ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
    };
    const r = await createAccountEntryAction(body, key.current);
    if (r.ok) onDone(r.data.receipt_no);
    else { key.current = newKey(); onFail(r.code); }
  };
  const err = (k: keyof typeof errors) => (errors[k] ? { error: errors[k]! } : {});
  return (
    <Dialog title={t('billing.accounts.entries.form_title')} isOpen onClose={onClose} size="lg">
      <Form onSubmit={submit} labelPlacement="start" errorSummary={false}>
        <div className="lims-form-grid">
          <Select label={t('billing.accounts.field.laboratory')} name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...(d.centre_id ? { value: d.centre_id } : {})} onChange={set('centre_id')} {...err('centre_id')} />
          <Select label={t('billing.accounts.field.client')} name="client" options={opts('credit_party')} {...(d.client ? { value: d.client } : {})} onChange={(v) => setD((x) => ({ ...x, client: v, franchise: undefined }))} {...err('party')} />
          <Select label={t('billing.accounts.field.franchise')} name="franchise" options={opts('franchise')} {...(d.franchise ? { value: d.franchise } : {})} onChange={(v) => setD((x) => ({ ...x, franchise: v, client: undefined }))} />
          <TextField label={t('billing.accounts.field.entry_date')} name="entry_date" maxLength={10} description={t('billing.accounts.field.date_hint')} value={d.entry_date} onChange={set('entry_date')} {...err('entry_date')} />
          <Select label={t('billing.accounts.field.particulars')} name="account_particular_id" options={particulars.map((p) => ({ value: p.id, label: p.name }))} {...(d.account_particular_id ? { value: d.account_particular_id } : {})} onChange={set('account_particular_id')} {...err('account_particular_id')} />
          <TextField label={t('billing.accounts.field.amount')} name="amount" inputMode="decimal" maxLength={17} value={d.amount} onChange={set('amount')} {...err('amount')} />
          <Select label={t('billing.accounts.field.type')} name="entry_type" options={(['credit', 'debit'] as const).map((v) => ({ value: v, label: typeText(v) }))} {...(d.entry_type ? { value: d.entry_type } : {})} onChange={set('entry_type')} {...err('entry_type')} />
          <LabelOnlySelect label={t('billing.accounts.field.payment_mode')} value={d.payment_mode} options={PAYMENT_MODES.map((m) => ({ value: m, label: modeText(m) }))} onChange={set('payment_mode')} error={errors.payment_mode} />
          <TextField label={t('billing.accounts.field.bank')} name="bank_name" maxLength={200} value={d.bank_name} onChange={set('bank_name')} {...err('bank_name')} />
          <TextField label={t('billing.accounts.field.reference')} name="reference_no" maxLength={100} value={d.reference_no} onChange={set('reference_no')} {...err('reference_no')} />
          <TextField label={t('billing.accounts.field.payment_details')} name="payment_details" maxLength={1000} value={d.payment_details} onChange={set('payment_details')} {...err('payment_details')} />
          <TextArea label={t('billing.accounts.field.comments')} name="comments" maxLength={2000} value={d.comments} onChange={set('comments')} />
        </div>
        <p className="lims-description">{t('billing.accounts.entries.server_fields')}</p>
        <div className="lims-inline">
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter">{t('billing.accounts.entries.submit')}</Button>
          {/* ElabAssist Account Entry "Search": list the entries matching what is filled in so far (the page filters sit behind the modal). */}
          <div role="search" aria-label={t('billing.accounts.entries.filters')}>
            <Button onPress={() => onSearch(Object.fromEntries(Object.entries({
              centre_id: d.centre_id,
              party: d.client ? `credit_party:${d.client}` : d.franchise ? `franchise:${d.franchise}` : undefined,
              account_particular_id: d.account_particular_id,
              entry_type: d.entry_type,
              entry_date_from: ISO_DATE.test(d.entry_date) ? d.entry_date : undefined,
              entry_date_to: ISO_DATE.test(d.entry_date) ? d.entry_date : undefined,
            }).filter(([, v]) => v)) as Filters)}>{t('billing.accounts.filter.search')}</Button>
          </div>
        </div>
      </Form>
    </Dialog>
  );
}

function ReverseDialog({ entry, onClose, onDone, onFail }: { entry: AccountLedgerEntry; onClose: () => void; onDone: () => void; onFail: (code: string) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const key = useRef(newKey());
  const submit = async () => {
    // Contract ReverseAccountLedgerEntryRequest.reason_text: 1-500 characters; blank is refused here, the API refuses too.
    if (!reason.trim() || reason.length > 500) return setError(t('billing.accounts.error.reason'));
    setError(undefined);
    const r = await reverseAccountEntryAction(entry.id, reason, key.current);
    if (r.ok) onDone();
    else { key.current = newKey(); onFail(r.code); }
  };
  return (
    <Dialog title={fill('billing.accounts.entries.reverse_title', { no: entry.receipt_no })} isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit} errorSummary={false}>
        <p className="lims-description">{t('billing.accounts.entries.reverse_help')}</p>
        {/* maxLength above 500 on purpose: an over-long paste is refused with a message, never silently cut. */}
        <TextArea label={t('billing.accounts.entries.reverse_reason')} name="reason_text" maxLength={1000} value={reason} onChange={(v) => { setReason(v); setError(undefined); }} {...(error ? { error } : {})} />
        <Button type="submit" variant="danger" shortcut="Ctrl+Enter">{t('billing.accounts.entries.reverse_confirm')}</Button>
      </Form>
    </Dialog>
  );
}
