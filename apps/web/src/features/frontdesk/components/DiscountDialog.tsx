'use client';
// F6 discount dialog (04-UI-UX §3.2 E): scope line/bill, kind amount/percent, value, reason. The quote decides whether approval is needed.
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import type { Item } from '../forms/draft';
import { listDiscountReasonsAction } from '../server/actions';
import type { CodedSetEntry, DraftDiscount } from '../server/types';

export function DiscountDialog({ items, onApply, onClose }: { items: Item[]; onApply: (d: DraftDiscount) => void; onClose: () => void }) {
  const [scope, setScope] = useState<'line' | 'bill'>('bill');
  const [kind, setKind] = useState<'amount' | 'percent'>('percent');
  const [line, setLine] = useState<string>();
  const [money, setMoney] = useState<Money>();
  const [pct, setPct] = useState<number>();
  const [reason, setReason] = useState<string>();
  const [reasons, setReasons] = useState<CodedSetEntry[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});
  // Reason comes from the F25 discount_reasons coded set (04-UI-UX:90), ordered by sort_order.
  useEffect(() => {
    let live = true;
    void listDiscountReasonsAction().then((r) => { if (live && r.ok) setReasons([...r.data].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))); });
    return () => { live = false; };
  }, []);

  const apply = () => {
    const e: Record<string, string> = {};
    if (scope === 'line' && !line) e['line'] = 'Choose a line';
    if (kind === 'amount' && !(money && money.amountPaisa >= 1)) e['value'] = 'Enter an amount';
    if (kind === 'percent' && !(pct && pct >= 1 && pct <= 100)) e['value'] = 'Enter a percent from 1 to 100';
    if (!reason) e['reason'] = 'A reason is required';
    setErr(e);
    if (Object.keys(e).length) return;
    const base = { scope, reason_code: reason!, ...(text.trim() ? { reason_text: text.trim() } : {}), ...(scope === 'line' && line ? { orderable_id: line } : {}) };
    onApply(kind === 'amount' ? { ...base, kind, amount_paisa: money!.amountPaisa } : { ...base, kind, percent_bp: pct! * 100 });
  };

  return (
    <Dialog title="Discount" isOpen onClose={onClose} size="md" footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" onPress={apply}>Apply discount</Button></>}>
      <RadioGroup label="Applies to" name="scope" orientation="horizontal" value={scope} onChange={setScope} options={[{ value: 'line', label: 'Line' }, { value: 'bill', label: 'Bill' }]} />
      {scope === 'line' ? <Select label="Line" name="line" isRequired options={items.map((i) => ({ value: i.orderable.id, label: `${i.orderable.code} — ${i.orderable.name}` }))} {...(line ? { value: line } : {})} onChange={setLine} {...(err['line'] ? { error: err['line'] } : {})} /> : null}
      <RadioGroup label="Kind" name="kind" orientation="horizontal" value={kind} onChange={setKind} options={[{ value: 'amount', label: 'Amount' }, { value: 'percent', label: 'Percent' }]} />
      {kind === 'amount'
        ? <MoneyField label="Discount amount" name="discount_amount" isRequired {...(money ? { value: money } : {})} onChange={setMoney} {...(err['value'] ? { error: err['value'] } : {})} />
        : <IntegerField label="Discount percent" name="discount_percent" min={1} max={100} isRequired {...(pct !== undefined ? { value: pct } : {})} onChange={setPct} {...(err['value'] ? { error: err['value'] } : {})} />}
      <Select label="Reason" name="reason_code" isRequired options={reasons.map((r) => ({ value: r.code, label: r.display }))} {...(reason ? { value: reason } : {})} onChange={setReason} {...(err['reason'] ? { error: err['reason'] } : {})} />
      <TextField label="Details" name="reason_text" maxLength={500} value={text} onChange={setText} />
    </Dialog>
  );
}
