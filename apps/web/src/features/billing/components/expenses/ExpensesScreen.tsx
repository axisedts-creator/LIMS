'use client';
// T0D-ACCT-2 (LD-313, LD-310): billing/expenses = ElabAssist Expense (Date Time, Expense Type, Amount, Lab Name, Description; Search, Add New, Save,
// Cancel). An expense is never edited or deleted (LD-313 b): the only correction is Cancel with a reason, then a new entry.
// Time is typed in Asia/Kathmandu (UTC+05:45, no DST) and sent as UTC.
import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { cancelExpenseAction, createExpenseAction } from '../../server/expenses.actions';
import type { Expense, ExpenseType } from '../../server/expenses.server';
import type { Named } from '../../server/accounts.server';
import { errorText, formatNpr, hasPerm } from '../format';
import { GatedButton, ISO_DATE, nameOf, newKey, toPaisa } from '../accounts/accountsShared';

const E = (k: string) => t(`billing.expenses.${k}`);
const REQ = 'billing.accounts.error.required';
const MANAGE = 'billing.expense.manage';
const REASON_ID = 'expenses-reason';
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** "2026-11-07T10:30" typed in Kathmandu -> "2026-11-07T04:45:00.000Z". */
const nptToUtc = (v: string) => new Date(`${v}:00+05:45`).toISOString();

export interface ExpensesScreenProps {
  expenses: readonly Expense[];
  types: readonly ExpenseType[];
  centres: readonly Named[];
  permissions: readonly string[];
  filters?: { centre_id?: string; expense_type_id?: string; from?: string; to?: string };
}

export function ExpensesScreen({ expenses, types, centres, permissions, filters = {} }: ExpensesScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [f, setF] = useState(filters);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<Expense | null>(null);
  const noManage = hasPerm(permissions, MANAGE) ? undefined : E('reason.no_manage');
  const search = () => {
    const p = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && (k === 'from' || k === 'to' ? ISO_DATE.test(v) : true)) as [string, string][]);
    router.push(p.toString() ? `${pathname}?${p}` : pathname);
  };
  const cancelBlock = (x: Expense) => noManage ?? (x.cancelled_at ? E('reason.already_cancelled') : undefined);

  const columns: ColumnDef<Expense>[] = [
    { id: 'expense_at', header: E('col.date_time'), cell: (x) => <DateText value={x.expense_at as never} mode="AD_BS" withTime /> },
    { id: 'type', header: E('col.type'), cell: (x) => nameOf(types, x.expense_type_id) },
    { id: 'amount', header: E('col.amount'), align: 'end', cell: (x) => formatNpr(x.amount_paisa) },
    { id: 'centre', header: E('col.lab'), cell: (x) => nameOf(centres, x.centre_id) },
    // Row header on Description: names the row and keeps the earlier cells (Amount) at their grid positions.
    { id: 'description', header: E('col.description'), isRowHeader: true, cell: (x) => x.description ?? '' },
    {
      id: 'status',
      header: E('col.status'),
      cell: (x) => (
        <span className="lims-inline">
          <span>{E(x.cancelled_at ? 'status.cancelled' : 'status.active')}</span>
          {x.cancel_reason_text ? <span>{x.cancel_reason_text}</span> : null}
        </span>
      ),
    },
    { id: 'action', header: E('col.action'), cell: (x) => <GatedButton label={E('cancel')} blocked={cancelBlock(x)} {...(noManage ? { reasonId: REASON_ID } : {})} onPress={() => setCancelling(x)} /> },
  ];

  return (
    <section aria-label={E('title')}>
      <PageHeader title={t('nav.billing.expenses')} helpKey="billing.accounts" actions={<GatedButton variant="primary" label={E('new')} blocked={noManage} reasonId={REASON_ID} onPress={() => setCreating(true)} />} />
      {noManage ? <p id={REASON_ID} className="lims-description">{noManage}</p> : null}
      <div role="search" aria-label={E('filters')} className="lims-filter-bar">
        <Select label={E('col.lab')} name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...(f.centre_id ? { value: f.centre_id } : {})} onChange={(v) => setF({ ...f, centre_id: v })} />
        <Select label={E('col.type')} name="expense_type_id" options={types.map((x) => ({ value: x.id, label: x.name }))} {...(f.expense_type_id ? { value: f.expense_type_id } : {})} onChange={(v) => setF({ ...f, expense_type_id: v })} />
        <TextField label={E('from')} name="from" maxLength={10} description={t('billing.accounts.field.date_hint')} value={f.from ?? ''} onChange={(v) => setF({ ...f, from: v })} />
        <TextField label={E('to')} name="to" maxLength={10} value={f.to ?? ''} onChange={(v) => setF({ ...f, to: v })} />
        <Button variant="primary" onPress={search}>{E('search')}</Button>
      </div>
      <DataTable caption={E('title')} density="compact" columns={columns} rows={expenses} getRowId={(x) => x.id} emptyState={{ title: E('empty') }} />
      {creating ? (
        <ExpenseDialog
          types={types.filter((x) => x.is_active)}
          centres={centres}
          onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); toast.show({ tone: 'success', title: E('saved') }); router.refresh(); }}
          onFail={(code) => toast.show({ tone: 'danger', title: E('failed'), description: errorText(code) })}
        />
      ) : null}
      {cancelling ? (
        <CancelDialog
          expense={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); toast.show({ tone: 'success', title: E('cancelled_ok') }); router.refresh(); }}
          onFail={(code) => toast.show({ tone: 'danger', title: E('failed'), description: errorText(code) })}
        />
      ) : null}
    </section>
  );
}

type Draft = { centre_id?: string; expense_type_id?: string; at: string; amount: string; description: string };
type Done = { onClose: () => void; onDone: () => void; onFail: (code: string) => void };

function ExpenseDialog({ types, centres, onClose, onDone, onFail }: { types: readonly ExpenseType[]; centres: readonly Named[] } & Done) {
  const [d, setD] = useState<Draft>({ at: '', amount: '', description: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [pending, setPending] = useState(false);
  const key = useRef(newKey());
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    const amount = toPaisa(d.amount);
    const e: typeof errors = {};
    if (!d.expense_type_id) e.expense_type_id = t(REQ);
    if (!d.centre_id) e.centre_id = t(REQ);
    if (!LOCAL_RE.test(d.at) || Number.isNaN(Date.parse(`${d.at}:00+05:45`))) e.at = E('error.date_time');
    if (amount === undefined) e.amount = t('billing.accounts.error.amount');
    if (d.description.length > 2000) e.description = E('error.description');
    setErrors(e);
    if (Object.keys(e).length) return;
    setPending(true);
    const desc = d.description.trim();
    const r = await createExpenseAction({ centre_id: d.centre_id!, expense_at: nptToUtc(d.at), expense_type_id: d.expense_type_id!, amount_paisa: amount!, ...(desc ? { description: desc } : {}) }, key.current);
    setPending(false);
    if (r.ok) onDone();
    else { key.current = newKey(); onFail(r.code); }
  };
  const err = (k: keyof Draft) => (errors[k] ? { error: errors[k]! } : {});
  return (
    <Dialog title={E('form_title')} isOpen onClose={onClose} size="md">
      <Form onSubmit={submit} errorSummary={false}>
        <div className="lims-field">
          <label className="lims-label" htmlFor="expense-at">{E('col.date_time')}</label>
          <input id="expense-at" type="datetime-local" className="lims-input" value={d.at} onChange={(ev) => set('at')(ev.target.value)} {...(errors.at ? { 'aria-invalid': true, 'aria-describedby': 'expense-at-e' } : {})} />
          {errors.at ? <p id="expense-at-e" className="lims-error">{errors.at}</p> : null}
        </div>
        <Select label={E('col.type')} name="expense_type_id" options={types.map((x) => ({ value: x.id, label: x.name }))} {...(d.expense_type_id ? { value: d.expense_type_id } : {})} onChange={set('expense_type_id')} {...err('expense_type_id')} />
        <TextField label={E('col.amount')} name="amount" inputMode="decimal" maxLength={17} value={d.amount} onChange={set('amount')} {...err('amount')} />
        <Select label={E('col.lab')} name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...(d.centre_id ? { value: d.centre_id } : {})} onChange={set('centre_id')} {...err('centre_id')} />
        <TextArea label={E('col.description')} name="description" maxLength={2000} value={d.description} onChange={set('description')} {...err('description')} />
        <div className="lims-inline">
          <Button type="submit" variant="primary" isLoading={pending} shortcut="Ctrl+Enter">{E('save')}</Button>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>{E('form_cancel')}</Button>
        </div>
      </Form>
    </Dialog>
  );
}

function CancelDialog({ expense, onClose, onDone, onFail }: { expense: Expense } & Done) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const key = useRef(newKey());
  const submit = async () => {
    // Contract CancelExpenseRequest.reason_text: 1-500 characters; blank is refused here, the API refuses too.
    if (!reason.trim() || reason.length > 500) return setError(E('error.reason'));
    setError(undefined);
    setPending(true);
    const r = await cancelExpenseAction(expense.id, reason.trim(), key.current);
    setPending(false);
    if (r.ok) onDone();
    else { key.current = newKey(); onFail(r.code); }
  };
  return (
    <Dialog title={E('cancel_title')} isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit} errorSummary={false}>
        <p className="lims-description">{`${expense.description ?? ''} ${formatNpr(expense.amount_paisa)}`.trim()}</p>
        {/* maxLength above 500 on purpose: an over-long paste is refused with a message, never silently cut. */}
        <TextArea label={E('cancel_reason')} name="reason_text" maxLength={1000} value={reason} onChange={(v) => { setReason(v); setError(undefined); }} {...(error ? { error } : {})} />
        <Button type="submit" variant="danger" isLoading={pending} shortcut="Ctrl+Enter">{E('cancel_confirm')}</Button>
      </Form>
    </Dialog>
  );
}
