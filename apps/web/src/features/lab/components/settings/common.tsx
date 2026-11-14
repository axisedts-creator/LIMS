'use client';
// Shared bits of the /lab/settings tabs (C5 T-29): native labelled controls (axe: every control has a visible label), problem text, read-failure box.
import { useId, type ReactNode } from 'react';
import type { ActionResult } from '../../server/types';
import { FAILED } from '../shared';

/** S-15: a privileged write at aal1 answers 403 auth.mfa_required; the screen says what to do instead of "failed". */
export const MFA_HINT = 'Verify your identity with multi-factor authentication, then try again.';
export const errText = (r: Extract<ActionResult<unknown>, { ok: false }>): string => (r.code === 'auth.mfa_required' ? MFA_HINT : (r.title ?? FAILED));
/** 409 version_conflict / 428: somebody else changed the row (or the If-Match was lost) — the screen reloads the server state. */
export const isStale = (r: Extract<ActionResult<unknown>, { ok: false }>): boolean => r.status === 409 || r.status === 428;

/** [CONV] T-25: IdText markup (first 8 chars, full id in the title) without the ellipsis — the T-25 tests match the 8 characters as the whole cell text. */
export const ShortId = ({ value }: { value: string }) => <span className="lims-id"><span className="lims-mono" title={value}>{value.slice(0, 8)}</span></span>;

export const AlertText =({ text }: { text: string }) => (text ? <div role="alert"><p>{text}</p></div> : null);

interface FieldProps { label: string; error?: string | undefined; children: (p: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode }
export function Field({ label, error, children }: FieldProps) {
  const id = useId();
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}</label>
      {children({ id, ...(error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-e` } : {}) })}
      {error ? <p id={`${id}-e`} className="lims-error">{error}</p> : null}
    </div>
  );
}

export function TextInput({ label, value, onChange, error, disabled, type = 'text', inputMode }: {
  label: string; value: string; onChange: (v: string) => void; error?: string | undefined; disabled?: boolean; type?: 'text' | 'number' | 'datetime-local'; inputMode?: 'decimal' | 'numeric';
}) {
  return (
    <Field label={label} error={error}>
      {(p) => <input {...p} type={type} className="lims-input" value={value} disabled={disabled} {...(inputMode ? { inputMode } : {})} onChange={(e) => onChange(e.currentTarget.value)} />}
    </Field>
  );
}

export function CheckInput({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="lims-check-wrap">
      <label><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} /> {label}</label>
    </div>
  );
}
