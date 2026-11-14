'use client';
// 04-UI-UX §8.5 Daily cash: staff × method table with totals, sessions table (variance as text), Export (B28 daily_cash), My shift + Close shift (B17b).
import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { MoneyField, type Money as FieldMoney } from '@lims/ui/components/MoneyField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { closeCashSessionAction } from '../server/actions';
import type { CashSession, DailyCash, Money } from '../server/types';
import { Ad, BsAd, errorText, formatNpr, hasPerm, humanize, npr } from './format';
import { ExportButtons } from './ExportButtons';

type Line = DailyCash['rows'][number] | { total: true; gross: Money; reversed: Money; net: Money };
const isTotal = (l: Line): l is Extract<Line, { total: true }> => 'total' in l;

/** "Short NPR x" / "Excess NPR x" — variance is text, never colour-only. */
export function varianceText(v: Money | undefined): string {
  if (!v || v.amount_paisa === 0) return 'No variance';
  return v.amount_paisa < 0 ? `Short ${formatNpr(-v.amount_paisa)}` : `Excess ${formatNpr(v.amount_paisa)}`;
}

export function DailyCashView({ report, session, permissions }: { report: DailyCash; session: CashSession | null; permissions: readonly string[] }) {
  const nav = useRouter();
  const pathname = usePathname();
  const lines: Line[] = [...report.rows, { total: true, ...report.totals }];
  const collections: ColumnDef<Line>[] = [
    { id: 'staff', header: 'Staff', isRowHeader: true, cell: (l) => (isTotal(l) ? <strong>Total</strong> : l.collected_by.display_name) },
    { id: 'method', header: 'Method', cell: (l) => (isTotal(l) ? '' : humanize(l.method_code)) },
    { id: 'entries', header: 'Entries', align: 'end', cell: (l) => (isTotal(l) ? '' : String(l.entries)) },
    { id: 'reversals', header: 'Reversals', align: 'end', cell: (l) => (isTotal(l) ? '' : String(l.reversals)) },
    { id: 'gross', header: 'Gross', align: 'end', cell: (l) => npr(l.gross) },
    { id: 'reversed', header: 'Reversed', align: 'end', cell: (l) => npr(l.reversed) },
    { id: 'net', header: 'Net', align: 'end', cell: (l) => npr(l.net) },
  ];
  const sessions: ColumnDef<CashSession>[] = [
    { id: 'staff', header: 'Staff', isRowHeader: true, cell: (s) => s.opened_by.display_name },
    { id: 'opened', header: 'Opened', cell: (s) => <Ad value={s.opened_at} withTime /> },
    { id: 'closed', header: 'Closed', cell: (s) => (s.closed_at ? <Ad value={s.closed_at} withTime /> : 'Open') },
    { id: 'expected', header: 'Expected cash', align: 'end', cell: (s) => npr(cashRow(s)?.expected) },
    { id: 'counted', header: 'Counted cash', align: 'end', cell: (s) => npr(cashRow(s)?.counted) },
    { id: 'variance', header: 'Variance', cell: (s) => varianceText(cashRow(s)?.variance) },
  ];
  return (
    <section aria-label="Daily cash">
      <PageHeader title="Daily cash" helpKey="billing.daily_cash" actions={hasPerm(permissions, 'billing.data.export') ? <ExportButtons kind="daily_cash" formats={['xlsx']} filters={{ from: report.business_date, to: report.business_date }} /> : null} />
      <DatePicker label="Business date" name="date" value={report.business_date as IsoDate} onChange={(d) => d && nav.replace(`${pathname}?date=${d}`)} />
      <p>Business date: <BsAd bs={report.business_date_bs} ad={report.business_date} /></p>
      {session && session.status === 'open' ? <MyShift session={session} /> : null}
      <DataTable caption="Collections by staff and method" columns={collections} rows={lines} getRowId={(l) => (isTotal(l) ? 'total' : `${l.collected_by.membership_id}-${l.method_code}`)} emptyState={{ title: 'No collections for this date.' }} />
      <h2>Sessions</h2>
      <DataTable caption="Cash sessions" columns={sessions} rows={report.sessions} getRowId={(s) => s.id} emptyState={{ title: 'No cash sessions for this date.' }} />
    </section>
  );
}

const cashRow = (s: CashSession) => s.rows.find((r) => r.method_code === 'cash') ?? s.rows[0];

function MyShift({ session }: { session: CashSession }) {
  const [closing, setClosing] = useState(false);
  return (
    <section aria-label="My shift">
      <h2>My shift</h2>
      <ul>{session.rows.map((r) => <li key={r.method_code}>{humanize(r.method_code)}: {npr(r.expected)}</li>)}</ul>
      <Button variant="primary" onPress={() => setClosing(true)}>Close shift</Button>
      {closing ? <CloseShiftDialog session={session} onClose={() => setClosing(false)} /> : null}
    </section>
  );
}

function CloseShiftDialog({ session, onClose }: { session: CashSession; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [counted, setCounted] = useState<Readonly<Record<string, FieldMoney | undefined>>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const key = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    const cash = counted['cash'];
    if (!cash) return setError('Enter the counted cash amount.');
    inFlight.current = true;
    try {
      const body = Object.entries(counted).filter((e): e is [string, FieldMoney] => !!e[1]).map(([method_code, m]) => ({ method_code, amount_paisa: m.amountPaisa }));
      const r = await closeCashSessionAction(session.id, session.version, { counted: body, ...(note ? { note } : {}) }, key.current);
      if (r.ok) { onClose(); toast.show({ tone: 'success', title: 'Shift closed.' }); router.refresh(); } else setError(errorText(r.code));
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Close shift" isOpen onClose={onClose} size="md">
      <Form onSubmit={submit}>
        {error ? <p role="alert">{error}</p> : null}
        {session.rows.map((r) => {
          const c = counted[r.method_code];
          return (
            <div key={r.method_code}>
              <MoneyField label={`Counted ${humanize(r.method_code)}`} name={`counted_${r.method_code}`} isRequired={r.method_code === 'cash'} {...(c ? { value: c } : {})} onChange={(v) => { setCounted({ ...counted, [r.method_code]: v }); setError(undefined); }} />
              <p>Expected {npr(r.expected)}{c ? ` — ${varianceText({ amount_paisa: c.amountPaisa - r.expected.amount_paisa, currency: 'NPR' })}` : ''}</p>
            </div>
          );
        })}
        <TextField label="Note" name="note" maxLength={500} value={note} onChange={setNote} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Close shift</Button>
      </Form>
    </Dialog>
  );
}
