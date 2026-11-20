'use client';
// T0D-FINCTRL-1 (LD-321, LD-310; LD-353 template 1 LIST): billing/discounts/authorities = ElabAssist Discount Authority (who may approve a discount
// above a requester limit, up to these ceilings). Columns User, Max Percent, Max Amount Per Bill, Active (+ Action). The contract has no update
// operation: create (Idempotency-Key) and deactivate (If-Match) only; to change a ceiling, deactivate and add a new row. Never deleted.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import type { Named } from '../../server/accounts.server';
import { createDiscountAuthorityAction, deactivateDiscountAuthorityAction, type DiscountActionResult } from '../../server/discounts.actions';
import type { DiscountAuthority } from '../../server/discounts.server';
import { formatAmount, hasPerm } from '../format';
import { GatedButton, LIST_FAILED, nameOf } from '../accounts/accountsShared';
import type { ListFailure } from '../listRead';
import { CeilingDialog, ConfirmDeactivate, DPERM, DT, activeText, failText, newKey, pctCell } from './discountShared';

const REASON_ID = 'discount-authorities-reason';

export interface DiscountAuthoritiesScreenProps { authorities: readonly DiscountAuthority[]; members: readonly Named[]; permissions: readonly string[]; failure?: ListFailure | undefined;
  /** Review fix (CR .orchestra/cr/T0D-FINCTRL-1.md): reason Add New and Edit stay disabled while the member ids differ from the API user_id. */
  idPending?: string | undefined }

export function DiscountAuthoritiesScreen({ authorities, members, permissions, failure, idPending }: DiscountAuthoritiesScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [deactivating, setDeactivating] = useState<DiscountAuthority | null>(null);
  const key = useRef(newKey());
  const blocked = hasPerm(permissions, DPERM.manage) ? undefined : DT('reason.no_manage');
  const writeBlocked = blocked ?? idPending;
  const done = () => { setAdding(false); setDeactivating(null); key.current = newKey(); toast.show({ tone: 'success', title: DT('saved') }); router.refresh(); };
  const fail = (r: DiscountActionResult) => { key.current = newKey(); if (!r.ok) toast.show({ tone: 'danger', title: DT('failed'), description: failText(r.code) }); };
  const active = new Set(authorities.filter((a) => a.is_active).map((a) => a.user_id));

  const columns: ColumnDef<DiscountAuthority>[] = [
    { id: 'user', header: DT('col.user'), isRowHeader: true, cell: (a) => nameOf(members, a.user_id) },
    { id: 'percent', header: DT('col.max_percent'), numeric: true, cell: (a) => pctCell(a.max_discount_bp) },
    { id: 'amount', header: `${DT('col.max_amount')} (NPR)`, numeric: true, cell: (a) => formatAmount(a.max_discount_paisa) },
    { id: 'active', header: DT('col.active'), cell: (a) => activeText(a.is_active) },
    { id: 'action', header: DT('col.action'), cell: (a) => (a.is_active ? <GatedButton label={DT('deactivate')} blocked={blocked} reasonId={REASON_ID} onPress={() => setDeactivating(a)} /> : '') },
  ];
  return (
    <section aria-label={DT('authorities.title')}>
      <PageHeader
        title={DT('authorities.title')}
        helpKey="billing.accounts"
        actions={<GatedButton variant="primary" label={DT('authorities.new')} blocked={writeBlocked} reasonId={REASON_ID} onPress={() => setAdding(true)} />}
      />
      {writeBlocked ? <p id={REASON_ID} className="lims-description">{writeBlocked}</p> : null}
      <DataTable
        caption={DT('authorities.title')}
        density="compact"
        columns={columns}
        rows={authorities}
        getRowId={(a) => a.id}
        emptyState={{ title: DT('authorities.empty') }}
        {...(failure ? { error: { title: LIST_FAILED, ...failure, onRetry: () => router.refresh() } } : {})}
      />
      {adding ? (
        <CeilingDialog
          title={DT('authorities.new_title')}
          users={members.filter((m) => !active.has(m.id))}
          save={async (userId, c) => { const r = await createDiscountAuthorityAction({ user_id: userId, ...c }, key.current); if (!r.ok) key.current = newKey(); return r; }}
          onClose={() => setAdding(false)}
          onDone={done}
          onFail={fail}
        />
      ) : null}
      {deactivating ? (
        <ConfirmDeactivate
          title={`${DT('deactivate')} ${nameOf(members, deactivating.user_id)}`}
          onClose={() => setDeactivating(null)}
          onConfirm={async () => { const r = await deactivateDiscountAuthorityAction(deactivating.id, deactivating.version); if (r.ok) done(); else fail(r); }}
        />
      ) : null}
    </section>
  );
}
