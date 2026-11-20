'use client';
// T0D-FINCTRL-1 (LD-321, LD-310; LD-353 template 1 LIST): billing/discounts/limits = ElabAssist Discount Limit (one row per user). Columns User,
// Max Percent, Max Amount Per Bill, Active (+ Action). setUserDiscountLimit is a PUT per user: Add New sends no If-Match, Edit and Deactivate send
// the row version. [CONV] Saving the form sets is_active true (an inactive limit is switched back on by Edit); Deactivate PUTs the same ceilings
// with is_active false. Never deleted.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import type { Named } from '../../server/accounts.server';
import { setDiscountLimitAction, type DiscountActionResult } from '../../server/discounts.actions';
import type { UserDiscountLimit } from '../../server/discounts.server';
import { formatAmount, hasPerm } from '../format';
import { GatedButton, LIST_FAILED, nameOf } from '../accounts/accountsShared';
import type { ListFailure } from '../listRead';
import { CeilingDialog, ConfirmDeactivate, DPERM, DT, activeText, failText, pctCell } from './discountShared';

const REASON_ID = 'discount-limits-reason';

export interface DiscountLimitsScreenProps { limits: readonly UserDiscountLimit[]; members: readonly Named[]; permissions: readonly string[]; failure?: ListFailure | undefined;
  /** Review fix (CR .orchestra/cr/T0D-FINCTRL-1.md): reason Add New and Edit stay disabled while the member ids differ from the API user_id. */
  idPending?: string | undefined }

export function DiscountLimitsScreen({ limits, members, permissions, failure, idPending }: DiscountLimitsScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<{ row?: UserDiscountLimit } | null>(null);
  const [deactivating, setDeactivating] = useState<UserDiscountLimit | null>(null);
  const blocked = hasPerm(permissions, DPERM.manage) ? undefined : DT('reason.no_manage');
  const writeBlocked = blocked ?? idPending;
  const done = () => { setEditing(null); setDeactivating(null); toast.show({ tone: 'success', title: DT('saved') }); router.refresh(); };
  const fail = (r: DiscountActionResult) => { if (!r.ok) toast.show({ tone: 'danger', title: DT('failed'), description: failText(r.code) }); };
  const withRow = new Set(limits.map((l) => l.user_id));

  const columns: ColumnDef<UserDiscountLimit>[] = [
    { id: 'user', header: DT('col.user'), isRowHeader: true, cell: (l) => nameOf(members, l.user_id) },
    { id: 'percent', header: DT('col.max_percent'), numeric: true, cell: (l) => pctCell(l.max_discount_bp) },
    { id: 'amount', header: `${DT('col.max_amount')} (NPR)`, numeric: true, cell: (l) => formatAmount(l.max_discount_paisa) },
    { id: 'active', header: DT('col.active'), cell: (l) => activeText(l.is_active) },
    {
      id: 'action',
      header: DT('col.action'),
      cell: (l) => (
        <span className="lims-inline">
          <GatedButton label={DT('edit')} blocked={writeBlocked} reasonId={REASON_ID} onPress={() => setEditing({ row: l })} />
          {l.is_active ? <GatedButton label={DT('deactivate')} blocked={blocked} reasonId={REASON_ID} onPress={() => setDeactivating(l)} /> : null}
        </span>
      ),
    },
  ];
  const row = editing?.row;
  return (
    <section aria-label={DT('limits.title')}>
      <PageHeader
        title={DT('limits.title')}
        helpKey="billing.accounts"
        actions={<GatedButton variant="primary" label={DT('limits.new')} blocked={writeBlocked} reasonId={REASON_ID} onPress={() => setEditing({})} />}
      />
      {writeBlocked ? <p id={REASON_ID} className="lims-description">{writeBlocked}</p> : null}
      <DataTable
        caption={DT('limits.title')}
        density="compact"
        columns={columns}
        rows={limits}
        getRowId={(l) => l.id}
        emptyState={{ title: DT('limits.empty') }}
        {...(failure ? { error: { title: LIST_FAILED, ...failure, onRetry: () => router.refresh() } } : {})}
      />
      {editing ? (
        <CeilingDialog
          title={DT(row ? 'limits.edit_title' : 'limits.new_title')}
          users={members.filter((m) => !withRow.has(m.id))}
          fixedUser={row ? { id: row.user_id, name: nameOf(members, row.user_id) } : undefined}
          initial={row}
          save={(userId, c) => setDiscountLimitAction(userId, { ...c, is_active: true }, row?.version)}
          onClose={() => setEditing(null)}
          onDone={done}
          onFail={fail}
        />
      ) : null}
      {deactivating ? (
        <ConfirmDeactivate
          title={`${DT('deactivate')} ${nameOf(members, deactivating.user_id)}`}
          onClose={() => setDeactivating(null)}
          onConfirm={async () => {
            const r = await setDiscountLimitAction(deactivating.user_id, { max_discount_bp: deactivating.max_discount_bp, max_discount_paisa: deactivating.max_discount_paisa, is_active: false }, deactivating.version);
            if (r.ok) done(); else fail(r);
          }}
        />
      ) : null}
    </section>
  );
}
