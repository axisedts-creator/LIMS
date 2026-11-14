'use client';
// Shared client helpers for the inventory master screens. LD-140 (2026-11-13): kit components and token names only; one primary
// button per page; every status shows tone + icon + word. The Idempotency-Key lives in a ref: reused on resubmit, new per form.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import type { FilterValue } from '@lims/ui/components/FilterBar';
import type { ActionResult } from '../server/types';

export type Failure = Extract<ActionResult<unknown>, { ok: false }>;

/** UUID v4 text (36 url-safe chars) is a valid Idempotency-Key (16-64 chars). */
export function newKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // ponytail: Math.random fallback for old browsers; keys are not secrets, only unique per attempt
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
export function useIdemKey() {
  const k = useRef<string | undefined>(undefined);
  return {
    get: () => (k.current ??= newKey()),
    reset: () => {
      k.current = undefined;
    },
  };
}

/** auth.mfa_required = step-up (aal2): nothing was saved, the form stays open with its values (AC-11.3, AC-19.3). */
export const isStepUp = (p: Failure | undefined) => p?.code === 'auth.mfa_required';

/**
 * Idempotency-Key per attempt: the same payload (resubmit after a failure) reuses the key, an edited payload gets a new one,
 * so the server never sees one key with two different bodies. `sig` is the JSON of what is about to be sent.
 */
export function useAttemptKey() {
  const k = useRef<{ sig: string; key: string } | undefined>(undefined);
  return {
    get: (sig: string) => {
      if (k.current?.sig !== sig) k.current = { sig, key: newKey() };
      return k.current.key;
    },
    reset: () => {
      k.current = undefined;
    },
  };
}

export function ProblemBanner({ problem }: { problem: Failure | undefined }) {
  if (!problem) return null;
  const stepUp = isStepUp(problem);
  const warn = stepUp || problem.code === 'common.version_conflict';
  return (
    <div role="alert">
      <Banner tone={warn ? 'warning' : 'danger'} title={stepUp ? 'Additional verification required' : problem.title || problem.code}>
        {stepUp ? <p>Verify your identity with your second factor, then submit again. Nothing was saved.</p> : null}
        {problem.requestId ? <p>{`Reference: ${problem.requestId}`}</p> : null}
      </Banner>
    </div>
  );
}

/** Server-side field message for a JSON-pointer path such as "/occurred_at" (400 common.validation_failed with errors[]). */
export const fieldMessage = (p: Failure | undefined, path: string) => p?.errors?.find((e) => e.path === path)?.message;

/** Quantity text: required, > 0, at most 3 decimals (DecimalStringPositive). Returns an error message or undefined. */
export function qtyError(label: string, text: string | undefined): string | undefined {
  const t = (text ?? '').trim();
  if (t === '') return `${label} is required`;
  if (!/^\d{1,12}(\.\d{1,3})?$/.test(t) || Number(t) <= 0) return `${label} must be greater than 0, with at most 3 decimals`;
  return undefined;
}
/** Same, but 0 is allowed (counted quantity). */
export function qtyOrZeroError(label: string, text: string | undefined): string | undefined {
  const t = (text ?? '').trim();
  if (t === '') return `${label} is required`;
  if (!/^\d{1,12}(\.\d{1,3})?$/.test(t)) return `${label} must be 0 or more, with at most 3 decimals`;
  return undefined;
}

/** Expiry as TEXT (LD-140: never colour alone). Dates are compared as UTC calendar days. */
export function expiryState(expiryOn: string | undefined, now = new Date()): { label: string; tone: 'danger' | 'warning' } | undefined {
  if (!expiryOn) return undefined;
  const days = Math.round((Date.parse(`${expiryOn}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(days)) return undefined;
  if (days < 0) return { label: 'Expired', tone: 'danger' };
  if (days <= 30) return { label: days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' };
  return undefined;
}

export const LOT_STATUS_LABEL: Record<string, string> = { available: 'Available', quarantined: 'Quarantined', blocked: 'Blocked' };

/** Label for a stock line picker: "TIPS-1 · Item name · LOT (exp 2027-01-01)". */
export const stockLabel = (b: { item_code: string; item_name: string; lot_no?: string | undefined; expiry_on?: string | undefined }) =>
  [b.item_code, b.item_name, b.lot_no ? `${b.lot_no}${b.expiry_on ? ` (exp ${b.expiry_on})` : ''}` : undefined].filter(Boolean).join(' · ');

export function ActiveChip({ active }: { active: boolean }) {
  return (
    <Inline gap={1}>
      <Icon name={active ? 'check' : 'info'} />
      <StatusChip kind="generic" status={active ? 'active' : 'inactive'} tone={active ? 'success' : 'neutral'} label={active ? 'Active' : 'Inactive'} size="sm" />
    </Inline>
  );
}

/**
 * Select whose empty state reads "<Label> — choose one": the kit Select's accessible name is "<value> <label>", so without a value the
 * placeholder keeps the control findable by its label. Pass `placeholder` to show a current default instead (then leave `value` unset).
 */
export function Pick({ label, name, options, value, onChange, error, isRequired, placeholder, description }: { label: string; name: string; options: readonly { value: string; label: string }[]; value?: string | undefined; onChange: (v: string) => void; error?: string | undefined; isRequired?: boolean; placeholder?: string; description?: string }) {
  return (
    <Select
      label={label}
      name={name}
      placeholder={placeholder ?? `${label} — choose one`}
      options={options}
      onChange={onChange}
      {...(value ? { value } : {})}
      {...(error ? { error } : {})}
      {...(isRequired ? { isRequired: true } : {})}
      {...(description ? { description } : {})}
    />
  );
}

/** Status as tone + icon + word (StatusChip draws the icon). */
export function Chip({ tone, label }: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; label: string }) {
  return <StatusChip kind="generic" status={label} tone={tone} label={label} size="sm" />;
}

export const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
export const isoDate = (s: string | undefined) => (s ? s.slice(0, 10) : '—');

/** Filters live in the URL (shareable, the server component re-fetches). Text is debounced. */
export function useUrlFilters(keys: readonly string[]) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [value, setValue] = useState<FilterValue>(() => Object.fromEntries(keys.map((k) => [k, sp.get(k) ?? undefined])));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      const p = new URLSearchParams(sp.toString());
      for (const k of keys) {
        const x = value[k];
        if (typeof x === 'string' && x) p.set(k, x);
        else p.delete(k);
      }
      p.delete('cursor');
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return { value, onChange: setValue, onReset: () => setValue({}) };
}
