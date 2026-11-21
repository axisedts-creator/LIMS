'use client';
// T0D-PARTYSET-1 (LD-321, LD-353 template 1 LIST): non compliance penalty events. Columns Date, Party, Penalty, Amount, Status. Filters Status and the
// native date inputs From / To (event_date, inclusive). Raise (party type, party, active penalty, date, amount defaulting to the penalty), and for RAISED
// rows only Waive (reason) and Charge: one debit on the party ledger, charged ONCE (the dialog's Idempotency-Key, one request at a time; a second
// charge answers 409 and is shown, never posted twice). [CONV] CONTRACT GAP (CR T0D-PARTYSET-1): NonComplianceEvent has no party or penalty name, so
// the names come from the party lists and the penalty list (one page of 200 each); an unknown party shows its type and the start of its id.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { NonComplianceEvent, NonCompliancePenalty, PartyKind } from '../server/partyset.server';
import type { NamedOption } from '../server/sales.server';
import { chargePenaltyEventAction, raisePenaltyEventAction, waivePenaltyEventAction } from '../server/partysetActions';
import { Ad } from './common';
import { DateField, KINDS, ReasonDialog, Status, hundredths, kindText, parsePaisa, rupees, today } from './PartysetCommon';
import { Alert, ConfirmWrite, SalesTable, failure, newKey, useOnce, useUrl, type Col } from './SalesCommon';

export type Parties = Record<PartyKind, NamedOption[]>;
const STATUSES = ['raised', 'waived', 'charged'] as const;
const ALL = 'all';
const FIELDS = ['party_kind', 'party_id', 'penalty_id', 'event_date', 'amount_paisa', 'reason'] as const;

function RaiseDialog({ parties, penalties, onClose, onDone }: { parties: Parties; penalties: readonly NonCompliancePenalty[]; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<PartyKind | ''>('');
  const [party, setParty] = useState('');
  const [penaltyId, setPenaltyId] = useState('');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const once = useOnce();
  const active = penalties.filter((p) => p.is_active);
  const penalty = active.find((p) => p.id === penaltyId);

  const save = () => once(async () => {
    const e: Record<string, string> = {};
    const req = t('partners.partyset.error.required');
    if (!kind) e['party_kind'] = req;
    if (!party) e['party_id'] = req;
    if (!penalty) e['penalty_id'] = req;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) e['event_date'] = req;
    const paisa = amount.trim() === '' ? undefined : parsePaisa(amount);
    if (amount.trim() !== '' && paisa === undefined) e['amount_paisa'] = t('partners.partyset.error.amount');
    setErrors(e);
    setText(Object.keys(e).length ? t('partners.partyset.check') : undefined);
    if (Object.keys(e).length || !penalty) return;
    const body: Record<string, unknown> = { party_kind: kind, party_id: party, penalty_id: penalty.id, event_date: date };
    if (paisa !== undefined && paisa !== penalty.amount_paisa) body['amount_paisa'] = paisa;
    if (reason.trim()) body['reason'] = reason.trim();
    setBusy(true);
    try {
      const r = await raisePenaltyEventAction(body, key);
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
    <Dialog title={t('partners.penalty_events.raise')} isOpen onClose={onClose} size="md"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.partyset.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.penalty_events.raise_go')}</Button></>}>
      <div className="lims-stack">
        <Select label={t('partners.penalty_events.field.party_type')} name="party_kind" options={KINDS.map((k) => ({ value: k, label: kindText(k) }))}
          {...(kind ? { value: kind } : {})} onChange={(k) => { setKind(k as PartyKind); setParty(''); }} {...err('party_kind')} />
        <Select label={t('partners.penalty_events.field.party')} name="party_id" options={kind ? parties[kind].map((p) => ({ value: p.id, label: p.name })) : []}
          {...(party ? { value: party } : {})} onChange={setParty} {...err('party_id')} />
        <Select label={t('partners.penalty_events.field.penalty')} name="penalty_id" options={active.map((p) => ({ value: p.id, label: p.name }))}
          {...(penaltyId ? { value: penaltyId } : {})} onChange={(id) => { setPenaltyId(id); const p = active.find((x) => x.id === id); if (p) setAmount(hundredths(p.amount_paisa)); }} {...err('penalty_id')} />
        <DateField label={t('partners.penalty_events.field.date')} value={date} onChange={setDate} error={errors['event_date']} />
        <TextField label={t('partners.penalty_events.field.amount')} name="amount" maxLength={20} inputMode="decimal" description={t('partners.penalty_events.amount_hint')} value={amount} onChange={setAmount} {...err('amount_paisa')} />
        <TextArea label={t('partners.penalty_events.field.reason')} name="reason" maxLength={500} value={reason} onChange={setReason} {...err('reason')} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export function PenaltyEvents({ rows, penalties, parties, filter, failed, nextCursor }: {
  rows: readonly NonComplianceEvent[];
  penalties: readonly NonCompliancePenalty[];
  parties: Parties;
  filter: { status?: string | undefined; from_date?: string | undefined; to_date?: string | undefined };
  failed?: string | undefined;
  nextCursor?: string | undefined;
}) {
  const toast = useToast();
  const url = useUrl();
  const [raising, setRaising] = useState(false);
  const [waiving, setWaiving] = useState<NonComplianceEvent | null>(null);
  const [charging, setCharging] = useState<{ row: NonComplianceEvent; key: string } | null>(null);
  const penaltyName = new Map(penalties.map((p) => [p.id, p.name]));
  const partyName = (e: NonComplianceEvent) => parties[e.party_kind]?.find((p) => p.id === e.party_id)?.name ?? `${kindText(e.party_kind)} ${e.party_id.slice(0, 8)}`;
  const done = (msg: string) => { setRaising(false); setWaiving(null); setCharging(null); toast.show({ tone: 'success', title: msg }); url.refresh(); };

  const columns: Col<NonComplianceEvent>[] = [
    { id: 'date', header: t('partners.penalty_events.col.date'), cell: (e) => <Ad value={e.event_date} /> },
    { id: 'party', header: t('partners.penalty_events.col.party'), isRowHeader: true, cell: partyName },
    { id: 'penalty', header: t('partners.penalty_events.col.penalty'), cell: (e) => penaltyName.get(e.penalty_id) ?? '—' },
    { id: 'amount', header: t('partners.penalty_events.col.amount'), align: 'end', cell: (e) => rupees(e.amount_paisa) },
    { id: 'status', header: t('partners.penalty_events.col.status'), cell: (e) => <Status code={e.status} label={t(`partners.penalty_events.status.${e.status}`)} /> },
    {
      id: 'actions', header: t('partners.partyset.col.actions'),
      cell: (e) => (e.status === 'raised' ? (
        <span className="lims-inline">
          <Button size="sm" variant="ghost" onPress={() => setWaiving(e)}>{t('partners.penalty_events.waive')}</Button>
          <Button size="sm" variant="ghost" onPress={() => setCharging({ row: e, key: newKey() })}>{t('partners.penalty_events.charge')}</Button>
        </span>
      ) : null),
    },
  ];
  const options = [{ value: ALL, label: t('partners.penalty_events.status.all') }, ...STATUSES.map((s) => ({ value: s, label: t(`partners.penalty_events.status.${s}`) }))];
  const status = filter.status && (STATUSES as readonly string[]).includes(filter.status) ? filter.status : ALL;

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.penalty_events')} helpKey="partners.penalty_events"
        actions={<Button variant="primary" onPress={() => setRaising(true)}>{t('partners.penalty_events.raise')}</Button>} />
      <div role="search" className="lims-filter-bar">
        <Select label={t('partners.penalty_events.filter.status')} name="status" options={options} value={status}
          onChange={(s) => { if (s !== status) url.go({ status: s === ALL ? undefined : s, cursor: undefined }); }} />
        <DateField label={t('partners.penalty_events.filter.from')} value={filter.from_date ?? ''} onChange={(v) => url.go({ from_date: v || undefined, cursor: undefined })} />
        <DateField label={t('partners.penalty_events.filter.to')} value={filter.to_date ?? ''} {...(filter.from_date ? { min: filter.from_date } : {})} onChange={(v) => url.go({ to_date: v || undefined, cursor: undefined })} />
      </div>
      <SalesTable caption={t('partners.nav.penalty_events')} columns={columns} rows={rows} getRowId={(e) => e.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('partners.penalty_events.empty'), body: t('partners.penalty_events.empty_hint') }} />
      {raising ? <RaiseDialog parties={parties} penalties={penalties} onClose={() => setRaising(false)} onDone={() => done(t('partners.penalty_events.raised'))} /> : null}
      {waiving ? (
        <ReasonDialog title={`${t('partners.penalty_events.waive_title')}: ${partyName(waiving)}`} confirm={t('partners.penalty_events.waive')}
          onClose={() => setWaiving(null)} onDone={() => done(t('partners.penalty_events.waived'))} act={(reason) => waivePenaltyEventAction(waiving.id, waiving.version, reason)} />
      ) : null}
      {charging ? (
        <ConfirmWrite title={t('partners.penalty_events.charge_title')}
          body={`${t('partners.penalty_events.charge_body')} ${partyName(charging.row)}, ${penaltyName.get(charging.row.penalty_id) ?? ''}: ${rupees(charging.row.amount_paisa)}`}
          confirm={t('partners.penalty_events.charge')} onClose={() => setCharging(null)} onDone={() => done(t('partners.penalty_events.charged'))}
          act={() => chargePenaltyEventAction(charging.row.id, charging.row.version, charging.key)} />
      ) : null}
    </section>
  );
}
