'use client';
// T0D-SALES-1 (LD-321, LD-353 template 1 LIST): ElabAssist Sales Client List. Columns Party, Type, Outstanding, Last Bill Date, Representative; Assign client
// (page action) and Unassign (row). Outstanding is integer paisa shown in rupees by the kit MoneyText (no float maths). The contract lists clients per
// representative, so the page merges one read per representative; a failed read leaves the other rows and a note.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { NamedOption, PartyKind, RepresentativeClient, SalesRepresentative } from '../server/sales.server';
import { assignPartyAction, unassignPartyAction } from '../server/salesActions';
import { Alert, ConfirmWrite, DateInput, Gated, SalesTable, canManage, failure, newKey, useOnce, useReason, useUrl, type Col } from './SalesCommon';

export type ClientRow = RepresentativeClient & { representative_id: string; representative_name: string };
const KINDS: readonly PartyKind[] = ['credit_party', 'partner', 'doctor', 'referrer'];
const kindLabel = (k: PartyKind) => t(`partners.sales.kind.${k}`);
const FIELDS = ['party_kind', 'party_id', 'representative_id', 'effective_from', 'effective_to'] as const;

function AssignDialog({ reps, parties, onClose, onDone }: { reps: readonly SalesRepresentative[]; parties: Record<PartyKind, NamedOption[]>; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Record<(typeof FIELDS)[number], string>>({ party_kind: '', party_id: '', representative_id: '', effective_from: '', effective_to: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const once = useOnce();
  const [key] = useState(newKey);
  const set = (k: (typeof FIELDS)[number]) => (x: string) => setV((o) => ({ ...o, [k]: x, ...(k === 'party_kind' && x !== o.party_kind ? { party_id: '' } : {}) }));
  const partyOptions = v.party_kind ? (parties[v.party_kind as PartyKind] ?? []).map((p) => ({ value: p.id, label: p.name })) : [];

  const save = () => once(async () => {
    const e: Record<string, string> = {};
    for (const k of ['party_kind', 'party_id', 'representative_id'] as const) if (!v[k]) e[k] = t('partners.sales.error.choose');
    if (!v.effective_from) e['effective_from'] = t('partners.sales.error.required');
    if (v.effective_to && v.effective_from && v.effective_to < v.effective_from) e['effective_to'] = t('partners.sales.error.date_order');
    setErrors(e);
    setText(undefined);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await assignPartyAction({
        party_kind: v.party_kind as PartyKind, party_id: v.party_id, representative_id: v.representative_id, effective_from: v.effective_from,
        ...(v.effective_to ? { effective_to: v.effective_to } : {}),
      }, key);
      if (r.ok) return onDone();
      const f = failure(r, FIELDS);
      setErrors(f.fields);
      setText(f.text);
    } finally {
      setBusy(false);
    }
  });

  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  return (
    <Dialog title={t('partners.sales.clients.assign')} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.sales.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.sales.save')}</Button></>}>
      <div className="lims-stack">
        <Select label={t('partners.sales.field.party_type')} name="party_kind" isRequired options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} {...(v.party_kind ? { value: v.party_kind } : {})} onChange={set('party_kind')} {...err('party_kind')} />
        <Select key={v.party_kind} label={t('partners.sales.field.party')} name="party_id" isRequired options={partyOptions} {...(v.party_id ? { value: v.party_id } : {})} onChange={set('party_id')} {...err('party_id')} />
        <Select label={t('partners.sales.field.representative')} name="representative_id" isRequired options={reps.filter((r) => r.is_active).map((r) => ({ value: r.id, label: r.name }))} {...(v.representative_id ? { value: v.representative_id } : {})} onChange={set('representative_id')} {...err('representative_id')} />
        <DateInput label={t('partners.sales.field.effective_from')} isRequired value={v.effective_from} onChange={set('effective_from')} error={errors['effective_from']} />
        <DateInput label={t('partners.sales.field.effective_to')} min={v.effective_from || undefined} value={v.effective_to} onChange={set('effective_to')} error={errors['effective_to']} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

function UnassignDialog({ row, onClose, onDone }: { row: ClientRow; onClose: () => void; onDone: () => void }) {
  const [last, setLast] = useState('');
  const [error, setError] = useState<string>();
  return (
    <ConfirmWrite
      title={`${t('partners.sales.clients.unassign_title')}: ${row.party_name}`} body={t('partners.sales.clients.unassign_body')} confirm={t('partners.sales.clients.unassign')}
      check={() => { const bad = !!last && last < row.effective_from; setError(bad ? t('partners.sales.error.date_order') : undefined); return !bad; }}
      act={() => unassignPartyAction(row.assignment_id, last || undefined)} onClose={onClose} onDone={onDone}
    >
      <DateInput label={t('partners.sales.field.last_day')} min={row.effective_from} value={last} onChange={setLast} error={error} />
    </ConfirmWrite>
  );
}

export function SalesClients({ rows, reps, parties, failed, partial, representativeId, partyKind, permissions }: {
  rows: readonly ClientRow[];
  reps: readonly SalesRepresentative[];
  parties: Record<PartyKind, NamedOption[]>;
  failed?: string | undefined;
  /** Some per-representative reads failed: the rows shown may be incomplete. */
  partial?: boolean;
  representativeId?: string | undefined;
  partyKind?: string | undefined;
  permissions: readonly string[];
}) {
  const manage = canManage(permissions);
  const reason = useReason(manage);
  const toast = useToast();
  const url = useUrl();
  const [assigning, setAssigning] = useState(false);
  const [leaving, setLeaving] = useState<ClientRow | null>(null);

  const done = (msg: string) => { setAssigning(false); setLeaving(null); toast.show({ tone: 'success', title: msg }); url.refresh(); };
  const columns: Col<ClientRow>[] = [
    { id: 'party', header: t('partners.sales.col.party'), isRowHeader: true, cell: (c) => c.party_name },
    { id: 'type', header: t('partners.sales.col.type'), cell: (c) => kindLabel(c.party_kind) },
    { id: 'outstanding', header: t('partners.sales.col.outstanding'), numeric: true, cell: (c) => <MoneyText value={{ amountPaisa: c.outstanding_paisa, currency: 'NPR' }} /> },
    { id: 'last_bill', header: t('partners.sales.col.last_bill_date'), cell: (c) => c.last_bill_date ?? t('partners.sales.clients.no_bill') },
    { id: 'rep', header: t('partners.sales.col.representative'), cell: (c) => c.representative_name },
    {
      id: 'actions', header: t('partners.sales.col.actions'),
      cell: (c) => <Gated size="sm" variant="ghost" reasonId={reason.id} onPress={() => setLeaving(c)}>{t('partners.sales.clients.unassign')}</Gated>,
    },
  ];
  const filters = [
    { id: 'representative_id', label: t('partners.sales.field.representative'), kind: 'select' as const, options: reps.map((r) => ({ value: r.id, label: r.name })) },
    { id: 'party_kind', label: t('partners.sales.col.type'), kind: 'select' as const, options: KINDS.map((k) => ({ value: k, label: kindLabel(k) })) },
  ];
  const value = { ...(representativeId ? { representative_id: representativeId } : {}), ...(partyKind ? { party_kind: partyKind } : {}) };

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.sales_clients')} helpKey="partners.sales.clients"
        actions={<Gated variant="primary" reasonId={reason.id} onPress={() => setAssigning(true)}>{t('partners.sales.clients.assign')}</Gated>} />
      {reason.line}
      <FilterBar filters={filters} value={value}
        onChange={(f) => {
          const r = typeof f['representative_id'] === 'string' ? f['representative_id'] : undefined;
          const k = typeof f['party_kind'] === 'string' ? f['party_kind'] : undefined;
          if (r !== representativeId || k !== partyKind) url.go({ representative_id: r, party_kind: k });
        }}
        onReset={() => url.go({ representative_id: undefined, party_kind: undefined })} />
      {partial ? <Alert text={t('partners.sales.partial')} /> : null}
      <SalesTable caption={t('partners.nav.sales_clients')} columns={columns} rows={rows} getRowId={(c) => c.assignment_id} failed={failed}
        empty={{ title: t('partners.sales.clients.empty'), body: t('partners.sales.clients.empty_hint') }} />
      {assigning ? <AssignDialog reps={reps} parties={parties} onClose={() => setAssigning(false)} onDone={() => done(t('partners.sales.clients.assigned'))} /> : null}
      {leaving ? <UnassignDialog row={leaving} onClose={() => setLeaving(null)} onDone={() => done(t('partners.sales.clients.unassigned'))} /> : null}
    </section>
  );
}
