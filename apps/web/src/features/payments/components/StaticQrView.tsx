'use client';
// 04-UI-UX §2.5 Fonepay QR worksheet (US-PG-12): compare the static-QR payments recorded at the counter with the bank statement.
// Fonepay is never presented as live or verified. The system total comes from the server (P18); the difference is shown, never typed.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { failText } from '../errors';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { dayNpt, hasPerm, humanize, kitMoney } from '../labels';
import { previewStaticQrAction, saveStaticQrAction } from '../server/actions';
import type { PaymentCentre, PaymentMoney, StaticQrReconDto } from '../types';

/** Standalone amount via kit MoneyText (04-UI-UX:21); em dash when absent. */
const amt = (m: PaymentMoney | undefined) => { const k = kitMoney(m); return k ? <MoneyText value={k} /> : <span className="lims-money">—</span>; };

type Iso = DateTextProps['value'];
const ALL = 'all';
const DAY_MS = 86_400_000;
const BANNER = 'Fonepay live payments are not available yet. Use this worksheet to compare Fonepay QR payments recorded at the counter with your bank statement.';
const STATUS = { matched: ['success', 'Matched'], accepted_with_difference: ['warning', 'Accepted with difference'] } as const;
type Preview = { s: 'loading' } | { s: 'error' } | { s: 'ok'; entries: number; total: PaymentMoney };
interface Errors { date?: string; statement?: string; reference?: string; note?: string }

export interface StaticQrViewProps { worksheets: readonly StaticQrReconDto[]; permissions: readonly string[]; centres: readonly PaymentCentre[] }

export function StaticQrView({ worksheets, permissions, centres }: StaticQrViewProps) {
  const router = useRouter();
  const toast = useToast();
  const canSave = hasPerm(permissions, 'payments.intent.resolve');
  const today = dayNpt() as IsoDate;
  const [date, setDate] = useState<IsoDate | undefined>(() => dayNpt(Date.now() - DAY_MS) as IsoDate);
  const [centre, setCentre] = useState(ALL);
  const [statement, setStatement] = useState<Money>();
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<Preview>({ s: 'loading' });
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const centreName = new Map(centres.map((c) => [c.id, c.name]));

  useEffect(() => {
    if (!date) return;
    let stale = false;
    setPreview({ s: 'loading' });
    previewStaticQrAction(date, centre === ALL ? undefined : centre).then(
      (r) => { if (!stale) setPreview(r.ok && r.totalPaisa !== undefined ? { s: 'ok', entries: r.entries ?? 0, total: { amount_paisa: r.totalPaisa, currency: 'NPR' } } : { s: 'error' }); },
      () => { if (!stale) setPreview({ s: 'error' }); },
    );
    return () => { stale = true; };
  }, [date, centre]);

  const total = preview.s === 'ok' ? preview.total.amount_paisa : undefined;
  const diff = total !== undefined && statement ? statement.amountPaisa - total : undefined;

  const submit = async () => {
    if (inFlight.current || !canSave) return;
    const e: Errors = {};
    if (!date) e.date = 'Enter Business date';
    if (!statement) e.statement = 'Enter Bank statement total';
    if (!reference.trim()) e.reference = 'Enter Statement reference';
    if (diff !== undefined && diff !== 0 && !note.trim()) e.note = 'Enter a note explaining the difference';
    setErrors(e);
    setBanner('');
    if (e.date || e.statement || e.reference || e.note || !date || !statement) return;
    if (diff === undefined) { setBanner('The system total is not available, so the difference cannot be checked. Try again later.'); return; }
    const body = { businessDate: date, ...(centre === ALL ? {} : { centreId: centre }), statementPaisa: statement.amountPaisa, reference: reference.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
    const sig = JSON.stringify(body);
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: globalThis.crypto.randomUUID() }; // a retry of the same worksheet replays; an edited one is a new request
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await saveStaticQrAction(body, attempt.current.key);
      if (res.ok) {
        attempt.current = null;
        toast.show({ tone: 'success', title: 'Worksheet saved.' });
        setStatement(undefined);
        setReference('');
        setNote('');
        router.refresh();
      } else setBanner(failText(res));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const columns: ColumnDef<StaticQrReconDto>[] = [
    { id: 'date', header: 'Date', isRowHeader: true, cell: (s) => <DateText value={s.business_date as Iso} /> },
    { id: 'centre', header: 'Centre', cell: (s) => (s.centre_id ? centreName.get(s.centre_id) ?? '—' : 'All centres') },
    { id: 'system', header: 'System', align: 'end', cell: (s) => amt(s.system_total) },
    { id: 'statement', header: 'Statement', align: 'end', cell: (s) => amt(s.statement_total) },
    { id: 'difference', header: 'Difference', align: 'end', cell: (s) => amt(s.difference) },
    { id: 'status', header: 'Status', cell: (s) => { const [tone, label] = Object.hasOwn(STATUS, s.status) ? STATUS[s.status as keyof typeof STATUS] : (['neutral', humanize(s.status)] as const); return <StatusChip kind="generic" status={s.status} tone={tone} label={label} />; } },
    { id: 'by', header: 'By', cell: (s) => s.reconciled_by?.display_name || '—' },
    { id: 'reference', header: 'Reference', cell: (s) => s.statement_reference || '—' }, // [CONV] not in the §2.5 column list; lets finance find the bank-statement line
  ];

  return (
    <>
      <PageHeader title="Fonepay QR worksheet" helpKey="payments.static_qr" />
      <Banner tone="info" title={BANNER} />
      {banner ? <div role="alert"><Banner tone="danger" title={banner} /></div> : null}
      <DatePicker label="Business date" name="business_date" isRequired max={today} {...(date ? { value: date } : {})} onChange={setDate} {...(errors.date ? { error: errors.date } : {})} />
      <Select label="Centre" name="centre_id" isRequired value={centre} onChange={setCentre} options={[{ value: ALL, label: 'All centres' }, ...centres.map((c) => ({ value: c.id, label: c.name }))]} />
      <div className="lims-field">
        <span className="lims-label">System total</span>
        {preview.s === 'ok' ? (
          <p>{amt(preview.total)} · <span>{preview.entries} {preview.entries === 1 ? 'entry' : 'entries'}</span></p>
        ) : preview.s === 'loading' ? <p>Loading…</p> : <p>The system total could not be loaded. Try again later.</p>}
      </div>
      <MoneyField label="Bank statement total" name="statement_total" isRequired {...(statement ? { value: statement } : {})} onChange={setStatement} {...(errors.statement ? { error: errors.statement } : {})} />
      <TextField label="Statement reference" name="statement_reference" maxLength={100} isRequired value={reference} onChange={setReference} {...(errors.reference ? { error: errors.reference } : {})} />
      <div className="lims-field">
        <span className={diff ? 'lims-label lims-tone-danger' : 'lims-label'}>Difference</span>
        {diff === undefined ? <span className="lims-money">—</span> : amt({ amount_paisa: diff, currency: 'NPR' })}
      </div>
      <TextArea label="Note" name="note" maxLength={1000} value={note} onChange={setNote} {...(errors.note ? { error: errors.note } : {})} />
      <Button variant="primary" isDisabled={!canSave} isLoading={busy} onPress={() => void submit()}>Save worksheet</Button>
      <DataTable<StaticQrReconDto>
        columns={columns} rows={worksheets} getRowId={(s) => s.id} density="compact" caption="Fonepay QR worksheets"
        emptyState={{ title: 'No worksheets yet.', body: 'Saved worksheets are listed here.' }}
      />
    </>
  );
}
