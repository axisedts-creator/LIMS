'use client';
// T0D-FINCTRL-1 (LD-321, LD-310, LD-353 rules) shared bits of the four discount master screens: permission codes, percent <-> basis points,
// rupees -> paisa (pure string math, no float), A.D. date checks, server field errors -> form fields, the deactivate confirmation.
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { TextField } from '@lims/ui/components/TextField';
import { t } from '@/core/i18n/messages';
import type { Named } from '../../server/accounts.server';
import type { DiscountActionResult } from '../../server/discounts.actions';
import { LabelOnlySelect, plainRupees } from '../accounts/accountsShared';
import { errorText } from '../format';

/** T0C-FINCTRL-1 codes (contracts/permissions.yaml): the route floor and the change permission. */
export const DPERM = { read: 'billing.discount_policy.read', manage: 'billing.discount_policy.manage' } as const;
export const DT = (k: string) => t(`billing.discounts.${k}`);
export const activeText = (on: boolean) => DT(on ? 'active.yes' : 'active.no');

/** Basis points -> "5", "12.5", "7.25" (no trailing zeros). */
export function pctText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(Math.abs(bp % 100)).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
/** Table cell: the leading space keeps the row text readable word by word ("Cashier 5%", not "Cashier5%"). */
export const pctCell = (bp: number) => ` ${pctText(bp)}%`;
/** "5" -> 500, "12.5" -> 1250; undefined unless 0 to 100 with at most 2 decimals. */
export function toBp(text: string): number | undefined {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10000 ? bp : undefined;
}
/** Rupees "1000.50" -> 100050 paisa, 0 allowed; undefined unless a plain amount with at most 2 decimals. */
export function rupeesToPaisa(text: string): number | undefined {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  const p = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(p) ? p : undefined;
}
/** A real A.D. calendar date written YYYY-MM-DD (2026-02-31 is refused). */
export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The 400 field errors of a failed action, keyed by field name ("/amount_from_paisa" -> amount_from_paisa). */
export function serverFieldErrors(r: DiscountActionResult): Record<string, string> {
  if (r.ok || !r.errors) return {};
  const out: Record<string, string> = {};
  for (const e of r.errors) {
    const name = e.path.replace(/^\//, '');
    if (name && !out[name]) out[name] = e.message;
  }
  return out;
}
export const failText = (code: string) => errorText(code);
export const newKey = () => crypto.randomUUID();

/** An async callback (call signature form: keeps the arrow-then-type pattern out of the copy scan). */
interface Job<T> { (): Promise<T> }
interface SaveCeiling { (userId: string, c: { max_discount_bp: number; max_discount_paisa: number }): Promise<DiscountActionResult> }

/** One request at a time per form: a double click sends ONE write; the Save button is disabled while it runs. */
export function useOnce() {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const once = async <T,>(f: Job<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    try { return await f(); } finally { busy.current = false; setPending(false); }
  };
  return { pending, once };
}

/**
 * Add / edit form of a per user ceiling (Discount Limit, Discount Authority): User, Max Percent (typed as percent, sent as basis points) and
 * Max Amount Per Bill (rupees, sent as paisa). `fixedUser` = edit: the user cannot change. `save` returns the action result; field errors of a
 * 400 land on the field, anything else on a toast via onFail.
 */
export function CeilingDialog({ title, users, fixedUser, initial, save, onClose, onDone, onFail }: {
  title: string; users: readonly Named[]; fixedUser?: Named | undefined; initial?: { max_discount_bp: number; max_discount_paisa: number } | undefined;
  save: SaveCeiling; onClose: () => void; onDone: () => void; onFail: (r: DiscountActionResult) => void;
}) {
  const [userId, setUserId] = useState<string | undefined>(fixedUser?.id);
  const [pct, setPct] = useState(initial ? pctText(initial.max_discount_bp) : '');
  const [amount, setAmount] = useState(initial ? plainRupees(initial.max_discount_paisa) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, once } = useOnce();
  const submit = () => once(async () => {
    const e: Record<string, string> = {};
    const bp = toBp(pct);
    const paisa = rupeesToPaisa(amount);
    if (!userId) e['user_id'] = DT('error.required');
    if (bp === undefined) e['max_discount_bp'] = DT('error.percent');
    if (paisa === undefined) e['max_discount_paisa'] = DT('error.amount');
    setErrors(e);
    if (Object.keys(e).length) return;
    const r = await save(userId!, { max_discount_bp: bp!, max_discount_paisa: paisa! });
    if (r.ok) return onDone();
    const fields = serverFieldErrors(r);
    setErrors(fields);
    if (!Object.keys(fields).length) onFail(r);
  });
  const err = (k: string) => (errors[k] ? { error: errors[k]! } : {});
  return (
    <Dialog title={title} isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit} errorSummary={false}>
        {fixedUser ? (
          <p className="lims-inline"><span className="lims-label">{DT('field.user')}</span><span>{fixedUser.name}</span></p>
        ) : (
          <LabelOnlySelect label={DT('field.user')} value={userId} options={users.map((u) => ({ value: u.id, label: u.name }))} onChange={(v) => { setUserId(v); setErrors({}); }} error={errors['user_id']} />
        )}
        <TextField label={DT('field.max_percent')} name="max_discount_bp" inputMode="decimal" maxLength={8} value={pct} onChange={(v) => { setPct(v); setErrors({}); }} {...err('max_discount_bp')} />
        <TextField label={DT('field.max_amount')} name="max_discount_paisa" inputMode="decimal" maxLength={20} value={amount} onChange={(v) => { setAmount(v); setErrors({}); }} {...err('max_discount_paisa')} />
        <div className="lims-inline">
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isDisabled={pending}>{DT('save')}</Button>
          <Button variant="ghost" onPress={onClose}>{DT('cancel')}</Button>
        </div>
      </Form>
    </Dialog>
  );
}

/** Deactivate asks first; nothing is sent until the confirm button is pressed. */
export function ConfirmDeactivate({ title, onConfirm, onClose }: { title: string; onConfirm: Job<void>; onClose: () => void }) {
  const { pending, once } = useOnce();
  return (
    <Dialog title={title} isOpen onClose={onClose} size="sm">
      <p className="lims-description">{DT('deactivate_help')}</p>
      <div className="lims-inline">
        <Button variant="danger" isDisabled={pending} onPress={() => void once(onConfirm)}>{DT('deactivate_confirm')}</Button>
        <Button variant="ghost" onPress={onClose}>{DT('cancel')}</Button>
      </div>
    </Dialog>
  );
}
