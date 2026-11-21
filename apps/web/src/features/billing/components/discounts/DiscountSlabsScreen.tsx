'use client';
// T0D-FINCTRL-1 (LD-321, LD-310; LD-353 template 1 LIST): billing/discounts/slabs = ElabAssist Discount slab per party. Columns Party Type, Party,
// From Amount, To Amount, Discount Percent, Effective From, Effective To, Active (+ Action). Percent is typed and shown as percent and sent as basis
// points; rupees are typed and shown from paisa. To Amount is exclusive (contract). Party is fixed after create; deactivate, never delete.
// A server field error (an overlapping slab on /amount_from_paisa) is shown on that field and the form keeps what was typed.
import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createDiscountSlabAction, deactivateDiscountSlabAction, updateDiscountSlabAction, type DiscountActionResult } from '../../server/discounts.actions';
import { SLAB_PARTY_KINDS } from '../../server/discountKinds';
import type { PartyDiscountSlab, SlabInput, SlabParty, SlabPartyKind } from '../../server/discounts.server';
import { formatAmount, hasPerm } from '../format';
import { GatedButton, LIST_FAILED, LabelOnlySelect, plainRupees } from '../accounts/accountsShared';
import type { ListFailure } from '../listRead';
import { ConfirmDeactivate, DPERM, DT, activeText, failText, isIsoDate, newKey, pctCell, pctText, rupeesToPaisa, serverFieldErrors, toBp, useOnce } from './discountShared';

const REASON_ID = 'discount-slabs-reason';
const kindText = (k: string) => DT(`party_kind.${k}`);
const kindOptions = SLAB_PARTY_KINDS.map((k) => ({ value: k, label: kindText(k) }));
type Filters = { party_kind?: string; party_id?: string };

export interface DiscountSlabsScreenProps {
  slabs: readonly PartyDiscountSlab[];
  parties: readonly SlabParty[];
  permissions: readonly string[];
  filters?: Filters;
  failure?: ListFailure | undefined;
}

export function DiscountSlabsScreen({ slabs, parties, permissions, filters = {}, failure }: DiscountSlabsScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [f, setF] = useState<Filters>(filters);
  const [editing, setEditing] = useState<{ row?: PartyDiscountSlab } | null>(null);
  const [deactivating, setDeactivating] = useState<PartyDiscountSlab | null>(null);
  const blocked = hasPerm(permissions, DPERM.manage) ? undefined : DT('reason.no_manage');
  const partyName = (s: { party_kind: string; party_id: string }) => parties.find((p) => p.kind === s.party_kind && p.id === s.party_id)?.name ?? '—';
  const done = () => { setEditing(null); setDeactivating(null); toast.show({ tone: 'success', title: DT('saved') }); router.refresh(); };
  const fail = (r: DiscountActionResult) => { if (!r.ok) toast.show({ tone: 'danger', title: DT('failed'), description: failText(r.code) }); };
  const search = () => {
    const p = new URLSearchParams();
    if (f.party_kind) p.set('party_kind', f.party_kind);
    if (f.party_kind && f.party_id) p.set('party_id', f.party_id);
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  };

  const columns: ColumnDef<PartyDiscountSlab>[] = [
    { id: 'party_kind', header: DT('col.party_kind'), cell: (s) => kindText(s.party_kind) },
    { id: 'party', header: DT('col.party'), cell: (s) => partyName(s) },
    { id: 'from', header: `${DT('col.from_amount')} (NPR)`, numeric: true, cell: (s) => formatAmount(s.amount_from_paisa) },
    { id: 'to', header: `${DT('col.to_amount')} (NPR)`, numeric: true, cell: (s) => formatAmount(s.amount_to_paisa) },
    { id: 'percent', header: DT('col.discount_percent'), numeric: true, cell: (s) => pctCell(s.discount_bp) },
    { id: 'effective_from', header: DT('col.effective_from'), cell: (s) => <DateText value={s.effective_from as never} mode="AD_BS" /> },
    { id: 'effective_to', header: DT('col.effective_to'), cell: (s) => (s.effective_to ? <DateText value={s.effective_to as never} mode="AD_BS" /> : DT('slabs.open_ended')) },
    // Row header on Active (after the data columns), so the party and amount cells keep their grid positions (same rule as the entries list).
    { id: 'active', header: DT('col.active'), isRowHeader: true, cell: (s) => activeText(s.is_active) },
    {
      id: 'action',
      header: DT('col.action'),
      cell: (s) => (
        <span className="lims-inline">
          <GatedButton label={DT('edit')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({ row: s })} />
          {s.is_active ? <GatedButton label={DT('deactivate')} blocked={blocked} reasonId={REASON_ID} onPress={() => setDeactivating(s)} /> : null}
        </span>
      ),
    },
  ];
  const filterParties = parties.filter((p) => p.kind === f.party_kind).map((p) => ({ value: p.id, label: p.name }));
  return (
    <section aria-label={DT('slabs.title')}>
      <PageHeader
        title={DT('slabs.title')}
        helpKey="billing.accounts"
        actions={<GatedButton variant="primary" label={DT('slabs.new')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({})} />}
      />
      {blocked ? <p id={REASON_ID} className="lims-description">{blocked}</p> : null}
      {/* T0D-UIGUARD-1-BILLING (LD-353 rule 2): the kit FilterBar holds the row; party kind, party, Search and Reset stay as they were. */}
      <FilterBar aria-label={DT('slabs.filters')} onReset={() => { setF({}); router.push(pathname); }} resetLabel={DT('reset')}>
        <LabelOnlySelect label={DT('field.party_kind')} value={f.party_kind} options={kindOptions} onChange={(v) => setF({ party_kind: v })} />
        <LabelOnlySelect label={DT('field.party')} value={f.party_id} options={filterParties} onChange={(v) => setF({ ...f, party_id: v })} />
        <Button variant="primary" onPress={search}>{DT('search')}</Button>
      </FilterBar>
      <DataTable
        caption={DT('slabs.title')}
        density="compact"
        columns={columns}
        rows={slabs}
        getRowId={(s) => s.id}
        emptyState={{ title: DT('slabs.empty') }}
        {...(failure ? { error: { title: LIST_FAILED, ...failure, onRetry: () => router.refresh() } } : {})}
      />
      {editing ? <SlabDialog row={editing.row} parties={parties} partyName={partyName} onClose={() => setEditing(null)} onDone={done} onFail={fail} /> : null}
      {deactivating ? (
        <ConfirmDeactivate
          title={`${DT('deactivate')} ${partyName(deactivating)}`}
          onClose={() => setDeactivating(null)}
          onConfirm={async () => { const r = await deactivateDiscountSlabAction(deactivating.id, deactivating.version); if (r.ok) done(); else fail(r); }}
        />
      ) : null}
    </section>
  );
}

type Draft = { party_kind?: SlabPartyKind | undefined; party_id?: string | undefined; from: string; to: string; pct: string; eff: string; end: string };

function SlabDialog({ row, parties, partyName, onClose, onDone, onFail }: {
  row?: PartyDiscountSlab | undefined; parties: readonly SlabParty[]; partyName: (s: PartyDiscountSlab) => string; onClose: () => void; onDone: () => void; onFail: (r: DiscountActionResult) => void;
}) {
  const [d, setD] = useState<Draft>(row
    ? { from: plainRupees(row.amount_from_paisa), to: plainRupees(row.amount_to_paisa), pct: pctText(row.discount_bp), eff: row.effective_from, end: row.effective_to ?? '' }
    : { from: '', to: '', pct: '', eff: '', end: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = useRef(newKey());
  const { pending, once } = useOnce();
  const set = (k: keyof Draft, field: string) => (v: string) => { setD((x) => ({ ...x, [k]: v })); setErrors((e) => { const n = { ...e }; delete n[field]; return n; }); };

  const submit = () => once(async () => {
    const e: Record<string, string> = {};
    const from = rupeesToPaisa(d.from);
    const to = rupeesToPaisa(d.to);
    const bp = toBp(d.pct);
    if (!row && !d.party_kind) e['party_kind'] = DT('error.required');
    if (!row && !d.party_id) e['party_id'] = DT('error.required');
    if (from === undefined) e['amount_from_paisa'] = DT('error.amount');
    if (to === undefined || to < 1) e['amount_to_paisa'] = DT('error.amount');
    else if (from !== undefined && to <= from) e['amount_to_paisa'] = DT('error.to_above_from');
    if (bp === undefined) e['discount_bp'] = DT('error.percent');
    if (!isIsoDate(d.eff)) e['effective_from'] = DT('error.date');
    if (d.end && !isIsoDate(d.end)) e['effective_to'] = DT('error.date');
    else if (d.end && isIsoDate(d.eff) && d.end < d.eff) e['effective_to'] = DT('error.end_before_start');
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: SlabInput = { amount_from_paisa: from!, amount_to_paisa: to!, discount_bp: bp!, effective_from: d.eff, ...(d.end ? { effective_to: d.end } : {}) };
    const r = row ? await updateDiscountSlabAction(row.id, row.version, body) : await createDiscountSlabAction({ party_kind: d.party_kind!, party_id: d.party_id!, ...body }, key.current);
    if (r.ok) return onDone();
    key.current = newKey();
    const fields = serverFieldErrors(r);
    setErrors(fields);
    if (!Object.keys(fields).length) onFail(r);
  });
  const err = (k: string) => (errors[k] ? { error: errors[k]! } : {});
  const partyOptions = parties.filter((p) => p.kind === d.party_kind).map((p) => ({ value: p.id, label: p.name }));
  return (
    <Dialog title={DT(row ? 'slabs.edit_title' : 'slabs.new_title')} isOpen onClose={onClose} size="md">
      <Form onSubmit={submit} errorSummary={false}>
        <div className="lims-form-grid">
          {row ? (
            <p className="lims-inline"><span className="lims-label">{DT('field.party')}</span><span>{`${kindText(row.party_kind)} · ${partyName(row)}`}</span></p>
          ) : (
            <>
              <LabelOnlySelect label={DT('field.party_kind')} value={d.party_kind} options={kindOptions} onChange={(v) => { setD((x) => ({ ...x, party_kind: v, party_id: x.party_kind === v ? x.party_id : undefined })); setErrors({}); }} error={errors['party_kind']} />
              <LabelOnlySelect label={DT('field.party')} value={d.party_id} options={partyOptions} onChange={(v) => { setD((x) => ({ ...x, party_id: v })); setErrors({}); }} error={errors['party_id']} />
            </>
          )}
          <TextField label={DT('field.from_amount')} name="amount_from_paisa" inputMode="decimal" maxLength={20} value={d.from} onChange={set('from', 'amount_from_paisa')} {...err('amount_from_paisa')} />
          <TextField label={DT('field.to_amount')} name="amount_to_paisa" inputMode="decimal" maxLength={20} value={d.to} description={DT('field.to_hint')} onChange={set('to', 'amount_to_paisa')} {...err('amount_to_paisa')} />
          <TextField label={DT('field.discount_percent')} name="discount_bp" inputMode="decimal" maxLength={8} value={d.pct} onChange={set('pct', 'discount_bp')} {...err('discount_bp')} />
          <TextField label={DT('field.effective_from')} name="effective_from" maxLength={10} value={d.eff} description={DT('field.date_hint')} onChange={set('eff', 'effective_from')} {...err('effective_from')} />
          <TextField label={DT('field.effective_to')} name="effective_to" maxLength={10} value={d.end} description={DT('field.end_hint')} onChange={set('end', 'effective_to')} {...err('effective_to')} />
        </div>
        <div className="lims-inline">
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isDisabled={pending}>{DT('save')}</Button>
          <Button variant="ghost" onPress={onClose}>{DT('cancel')}</Button>
        </div>
      </Form>
    </Dialog>
  );
}
