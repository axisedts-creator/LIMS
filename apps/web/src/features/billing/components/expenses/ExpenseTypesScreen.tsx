'use client';
// T0D-ACCT-2 (LD-313, LD-310): billing/expenses/types = ElabAssist Expense Type master (Add New, Update, Cancel). Never deleted: Deactivate instead,
// so old expenses keep their type. Each type posts to one account particular; updates send If-Match with the row version.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { saveExpenseTypeAction } from '../../server/expenses.actions';
import type { ExpenseType } from '../../server/expenses.server';
import type { AccountParticular } from '../../server/accounts.server';
import { errorText, hasPerm } from '../format';
import { GatedButton, nameOf, newKey } from '../accounts/accountsShared';

const T = (k: string) => t(`billing.expense_types.${k}`);
const MANAGE = 'billing.account.manage'; // contract: create/updateExpenseType need billing.account.manage
const REASON_ID = 'expense-types-reason';

export interface ExpenseTypesScreenProps { types: readonly ExpenseType[]; particulars: readonly AccountParticular[]; permissions: readonly string[] }

export function ExpenseTypesScreen({ types, particulars, permissions }: ExpenseTypesScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<{ row?: ExpenseType } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const blocked = hasPerm(permissions, MANAGE) ? undefined : T('reason.no_manage');
  const done = () => { setEditing(null); toast.show({ tone: 'success', title: T('saved') }); router.refresh(); };
  const fail = (code: string) => toast.show({ tone: 'danger', title: T('failed'), description: errorText(code) });
  const deactivate = async (row: ExpenseType) => {
    if (busy) return;
    setBusy(row.id);
    const r = await saveExpenseTypeAction({ id: row.id, version: row.version }, { is_active: false }, newKey());
    setBusy(null);
    if (r.ok) done(); else fail(r.code);
  };
  const columns: ColumnDef<ExpenseType>[] = [
    { id: 'name', header: T('col.name'), isRowHeader: true, cell: (x) => x.name },
    { id: 'particular', header: T('col.particular'), cell: (x) => nameOf(particulars, x.account_particular_id) },
    { id: 'state', header: T('col.status'), cell: (x) => T(x.is_active ? 'status.active' : 'status.inactive') },
    {
      id: 'action',
      header: T('col.action'),
      cell: (x) => (
        <span className="lims-inline">
          <GatedButton label={T('edit')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({ row: x })} />
          {x.is_active ? <GatedButton label={T('deactivate')} blocked={blocked ?? (busy ? T('working') : undefined)} {...(blocked ? { reasonId: REASON_ID } : {})} onPress={() => void deactivate(x)} /> : null}
        </span>
      ),
    },
  ];
  return (
    <section aria-label={T('title')}>
      <PageHeader title={t('nav.billing.expense_types')} helpKey="billing.accounts" actions={<GatedButton variant="primary" label={T('new')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({})} />} />
      {blocked ? <p id={REASON_ID} className="lims-description">{blocked}</p> : null}
      <DataTable caption={T('title')} density="compact" columns={columns} rows={types} getRowId={(x) => x.id} emptyState={{ title: T('empty') }} />
      {editing ? <TypeDialog row={editing.row} particulars={particulars.filter((p) => p.is_active || p.id === editing.row?.account_particular_id)} onClose={() => setEditing(null)} onDone={done} onFail={fail} /> : null}
    </section>
  );
}

function TypeDialog({ row, particulars, onClose, onDone, onFail }: { row: ExpenseType | undefined; particulars: readonly AccountParticular[]; onClose: () => void; onDone: () => void; onFail: (code: string) => void }) {
  const [name, setName] = useState(row?.name ?? '');
  const [particular, setParticular] = useState<string | undefined>(row?.account_particular_id);
  const [errors, setErrors] = useState<{ name?: string; particular?: string }>({});
  const [pending, setPending] = useState(false);
  const key = useRef(newKey());
  const submit = async () => {
    const e: typeof errors = {};
    if (!name.trim()) e.name = t('billing.accounts.error.required');
    if (!particular) e.particular = t('billing.accounts.error.required');
    setErrors(e);
    if (Object.keys(e).length) return;
    setPending(true);
    const patch = row
      ? { ...(name.trim() !== row.name ? { name: name.trim() } : {}), ...(particular !== row.account_particular_id ? { account_particular_id: particular! } : {}) }
      : { name: name.trim(), account_particular_id: particular! };
    if (row && !Object.keys(patch).length) { setPending(false); return onClose(); }
    const r = await saveExpenseTypeAction(row ? { id: row.id, version: row.version } : null, patch, key.current);
    setPending(false);
    if (r.ok) onDone();
    else { key.current = newKey(); onFail(r.code); }
  };
  return (
    <Dialog title={T(row ? 'edit_title' : 'new_title')} isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit} errorSummary={false}>
        <TextField label={T('col.name')} name="name" maxLength={200} value={name} onChange={setName} {...(errors.name ? { error: errors.name } : {})} />
        <Select label={T('col.particular')} name="account_particular_id" options={particulars.map((p) => ({ value: p.id, label: p.name }))} {...(particular ? { value: particular } : {})} onChange={setParticular} {...(errors.particular ? { error: errors.particular } : {})} />
        <div className="lims-inline">
          <Button type="submit" variant="primary" isLoading={pending} shortcut="Ctrl+Enter">{T('save')}</Button>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>{T('form_cancel')}</Button>
        </div>
      </Form>
    </Dialog>
  );
}
