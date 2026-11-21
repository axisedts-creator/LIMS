'use client';
// T0D-PARTYSET-1 (LD-321, LD-353): shared parts of the party settings screens (Onboarding Queue, Penalty Master, Penalty Events, ICD Master).
//   - integer conversions done on the text (money: rupees <-> paisa; percent: percent <-> basis points), never with floats;
//   - SearchBar: the one-row FilterBar of the master lists with a native search box (?q=, Enter searches);
//   - ReasonDialog: a required reason (1 to 500 characters) before Hold, Reject or Waive;
//   - the status chip (word + tone; colour only inside the chip, LD-353 rule 4);
//   - DateField: a native date input (no picker library, light on low end PCs) with its label above and its error.
import { useId, useState, type ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { t } from '@/core/i18n/messages';
import type { PartysetResult } from '../server/partysetActions';
import { Alert, failure, useOnce, useUrl } from './SalesCommon';

export { formatAmount as rupees } from '@/features/billing/components/format';

/** Two-decimal text of an integer in hundredths: 1250 -> "12.50", 5 -> "0.05" (basis points as percent, paisa as rupees). */
export function hundredths(n: number): string {
  const s = String(Math.abs(n)).padStart(3, '0');
  return `${n < 0 ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
}
/** "12.5" -> 1250; at most two decimals, digits only; undefined when malformed. Integer maths on the text (no float rounding). */
export function parseHundredths(text: string, maxWhole = 13): number | undefined {
  const m = new RegExp(`^(\\d{1,${maxWhole}})(?:\\.(\\d{1,2}))?$`).exec(text.trim());
  if (!m) return undefined;
  const n = Number(`${m[1]}${(m[2] ?? '').padEnd(2, '0')}`);
  return Number.isSafeInteger(n) ? n : undefined;
}
export const MAX_PAISA = 100_000_000_000;
/** Rupees text -> paisa, 0 to 1,000,000,000.00. */
export const parsePaisa = (text: string) => { const p = parseHundredths(text, 10); return p !== undefined && p <= MAX_PAISA ? p : undefined; };
/** Percent text -> basis points, 0 to 100. */
export const parseBp = (text: string) => { const p = parseHundredths(text, 3); return p !== undefined && p <= 10000 ? p : undefined; };

export const KINDS = ['partner', 'credit_party', 'doctor', 'referrer'] as const;
export const kindText = (k: string) => t(`partners.partyset.kind.${k}`);
export const yesNo = (v: boolean) => t(v ? 'partners.partyset.yes' : 'partners.partyset.no');
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const TONES: Record<string, Tone> = { pending: 'info', held: 'warning', approved: 'success', rejected: 'danger', raised: 'warning', waived: 'neutral', charged: 'success' };
/** `label` is the catalogue word; the chip carries the tone. */
export const Status = ({ code, label }: { code: string; label: string }) => <StatusChip kind="generic" status={code} tone={TONES[code] ?? 'neutral'} label={label} />;

export function DateField({ label, value, onChange, error, min }: { label: string; value: string; onChange: (v: string) => void; error?: string | undefined; min?: string | undefined }) {
  const id = useId();
  return (
    <div className="lims-field">
      <label htmlFor={id} className="lims-label">{label}</label>
      <input id={id} type="date" className="lims-input" value={value} onChange={(e) => onChange(e.target.value)} {...(min ? { min } : {})}
        {...(error ? { 'aria-invalid': true, 'aria-describedby': `${id}-e` } : {})} />
      {error ? <span id={`${id}-e`} className="lims-error">{error}</span> : null}
    </div>
  );
}

/** The one-row FilterBar of a master list: a search box (?q=, Enter or Search) and optional extra controls. */
export function SearchBar({ q, children }: { q: string | undefined; children?: ReactNode }) {
  const url = useUrl();
  const id = useId();
  const [text, setText] = useState(q ?? '');
  return (
    <form role="search" className="lims-filter-bar" onSubmit={(e) => { e.preventDefault(); url.go({ q: text.trim() || undefined, cursor: undefined }, true); }}>
      <div className="lims-filter-search">
        <div className="lims-field">
          <label htmlFor={id} className="lims-label">{t('partners.partyset.search')}</label>
          <input id={id} type="search" className="lims-input" maxLength={64} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Button type="submit">{t('partners.partyset.search')}</Button>
      </div>
      {children}
    </form>
  );
}

/** A required reason, then one write. A refusal stays in the dialog as a plain sentence. */
export function ReasonDialog({ title, confirm, onClose, onDone, act }: {
  title: string; confirm: string; onClose: () => void; onDone: () => void; act: (reason: string) => Promise<PartysetResult>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const once = useOnce();
  const go = () => once(async () => {
    const r = reason.trim();
    if (!r || r.length > 500) { setError(t('partners.partyset.error.reason')); return; }
    setError(undefined);
    setText(undefined);
    setBusy(true);
    try {
      const res = await act(r);
      if (res.ok) return onDone();
      const f = failure(res, ['reason']);
      if (f.fields['reason']) setError(f.fields['reason']);
      setText(f.text);
    } finally {
      setBusy(false);
    }
  });
  return (
    <Dialog title={title} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.partyset.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void go()}>{confirm}</Button></>}>
      <div className="lims-stack">
        <TextArea label={t('partners.onboarding.reason')} name="reason" maxLength={500} isRequired description={t('partners.onboarding.reason_hint')} value={reason}
          onChange={(v) => { setReason(v); setError(undefined); }} {...(error ? { error } : {})} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}
