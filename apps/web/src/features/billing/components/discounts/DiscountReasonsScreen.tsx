'use client';
// T0D-FINCTRL-1 (LD-321, LD-310; LD-353 template 1 LIST): billing/discounts/reasons = ElabAssist Discount Reason. Columns Code, Name, Active (+ Action).
// Create and edit; deactivate, never delete. Code is upper case and immutable after create (contract): Edit sends the name only, with If-Match.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createDiscountReasonAction, updateDiscountReasonAction, type DiscountActionResult } from '../../server/discounts.actions';
import type { DiscountReason } from '../../server/discounts.server';
import { hasPerm } from '../format';
import { GatedButton, LIST_FAILED } from '../accounts/accountsShared';
import type { ListFailure } from '../listRead';
import { ConfirmDeactivate, DPERM, DT, activeText, failText, newKey, serverFieldErrors, useOnce } from './discountShared';

const CODE_RE = /^[A-Z0-9_]{1,32}$/;
const REASON_ID = 'discount-reasons-reason';

export interface DiscountReasonsScreenProps { reasons: readonly DiscountReason[]; permissions: readonly string[]; failure?: ListFailure | undefined }

export function DiscountReasonsScreen({ reasons, permissions, failure }: DiscountReasonsScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<{ row?: DiscountReason } | null>(null);
  const [deactivating, setDeactivating] = useState<DiscountReason | null>(null);
  const blocked = hasPerm(permissions, DPERM.manage) ? undefined : DT('reason.no_manage');
  const done = () => { setEditing(null); setDeactivating(null); toast.show({ tone: 'success', title: DT('saved') }); router.refresh(); };
  const fail = (r: DiscountActionResult) => { if (!r.ok) toast.show({ tone: 'danger', title: DT('failed'), description: failText(r.code) }); };

  const columns: ColumnDef<DiscountReason>[] = [
    { id: 'code', header: DT('col.code'), isRowHeader: true, cell: (r) => r.code },
    { id: 'name', header: DT('col.name'), cell: (r) => r.name },
    { id: 'active', header: DT('col.active'), cell: (r) => activeText(r.is_active) },
    {
      id: 'action',
      header: DT('col.action'),
      cell: (r) => (
        <span className="lims-inline">
          <GatedButton label={DT('edit')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({ row: r })} />
          {r.is_active ? <GatedButton label={DT('deactivate')} blocked={blocked} reasonId={REASON_ID} onPress={() => setDeactivating(r)} /> : null}
        </span>
      ),
    },
  ];
  return (
    <section aria-label={DT('reasons.title')}>
      <PageHeader
        title={DT('reasons.title')}
        helpKey="billing.accounts"
        actions={<GatedButton variant="primary" label={DT('reasons.new')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({})} />}
      />
      {blocked ? <p id={REASON_ID} className="lims-description">{blocked}</p> : null}
      <DataTable
        caption={DT('reasons.title')}
        density="compact"
        columns={columns}
        rows={reasons}
        getRowId={(r) => r.id}
        emptyState={{ title: DT('reasons.empty') }}
        {...(failure ? { error: { title: LIST_FAILED, ...failure, onRetry: () => router.refresh() } } : {})}
      />
      {editing ? <ReasonDialog row={editing.row} onClose={() => setEditing(null)} onDone={done} onFail={fail} /> : null}
      {deactivating ? (
        <ConfirmDeactivate
          title={`${DT('deactivate')} ${deactivating.code}`}
          onClose={() => setDeactivating(null)}
          onConfirm={async () => { const r = await updateDiscountReasonAction(deactivating.id, deactivating.version, { is_active: false }); if (r.ok) done(); else fail(r); }}
        />
      ) : null}
    </section>
  );
}

function ReasonDialog({ row, onClose, onDone, onFail }: { row?: DiscountReason | undefined; onClose: () => void; onDone: () => void; onFail: (r: DiscountActionResult) => void }) {
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = useRef(newKey());
  const { pending, once } = useOnce();
  const submit = () => once(async () => {
    const e: Record<string, string> = {};
    if (!row && !CODE_RE.test(code)) e['code'] = DT('error.code');
    if (!name.trim() || name.length > 200) e['name'] = DT('error.name');
    setErrors(e);
    if (Object.keys(e).length) return;
    const r = row ? await updateDiscountReasonAction(row.id, row.version, { name: name.trim() }) : await createDiscountReasonAction({ code, name: name.trim() }, key.current);
    if (r.ok) return onDone();
    key.current = newKey();
    const fields = serverFieldErrors(r);
    setErrors(fields);
    if (!Object.keys(fields).length) onFail(r);
  });
  const err = (k: string) => (errors[k] ? { error: errors[k]! } : {});
  return (
    <Dialog title={DT(row ? 'reasons.edit_title' : 'reasons.new_title')} isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit} errorSummary={false}>
        {/* maxLength above 32 on purpose: a longer code is refused with a message, never silently cut. */}
        <TextField label={DT('field.code')} name="code" maxLength={64} value={code} isReadOnly={!!row} {...(row ? {} : { description: DT('field.code_hint') })} onChange={(v) => { setCode(v); setErrors({}); }} {...err('code')} />
        <TextField label={DT('field.name')} name="name" maxLength={200} value={name} onChange={(v) => { setName(v); setErrors({}); }} {...err('name')} />
        <div className="lims-inline">
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isDisabled={pending}>{DT('save')}</Button>
          <Button variant="ghost" onPress={onClose}>{DT('cancel')}</Button>
        </div>
      </Form>
    </Dialog>
  );
}
