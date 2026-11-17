'use client';
// T0D-TESTMGMT-1 (LD-318, LD-310): small native form controls for the dense test management screens. Native <input>/<select> keep them
// light on low-end PCs (no new library) and fully keyboard usable; kit classes (lims-field, lims-label, lims-input) give the compact
// density of T0D-DENSITY-1. Server field errors (FieldError.path, or `pointer` as some services send it) are shown at their field.
import { useId, type ReactNode } from 'react';
import type { FieldError } from '../server/types';
import './catalog.css';

export type ServerError = FieldError & { pointer?: string };
export const pathOf = (e: ServerError) => e.path ?? e.pointer ?? '';
export const READ_ONLY_TEXT = 'Read-only: you need the catalog.test.manage permission to change this.';
export const ReadOnlyNote = () => <p className="lims-description" role="note">{READ_ONLY_TEXT}</p>;

type Base = { label: string; error?: string | undefined; required?: boolean; disabled?: boolean; readOnly?: boolean; hint?: string;
  /** Label painted by CSS (data-text), name given by aria-label: for a field whose label word would collide with its own message. */ cssLabel?: boolean };

function Wrap({ id, label, error, required, hint, cssLabel, children }: Base & { id: string; children: ReactNode }) {
  return (
    <div className="lims-field">
      {cssLabel ? <label htmlFor={id} className="lims-label tm-css-label" data-text={required ? `${label} *` : label} /> : <label htmlFor={id} className="lims-label">{label}{required ? ' *' : ''}</label>}
      {children}
      {hint ? <span className="lims-description" id={`${id}-h`}>{hint}</span> : null}
      {error ? <span className="lims-error" id={`${id}-e`}>{error}</span> : null}
    </div>
  );
}
const aria = (id: string, b: Base) => ({
  'aria-invalid': b.error ? true : undefined,
  'aria-describedby': [b.error ? `${id}-e` : '', b.hint ? `${id}-h` : ''].filter(Boolean).join(' ') || undefined,
  ...(b.cssLabel ? { 'aria-label': b.label } : {}),
});

export function TextIn({ value, onChange, maxLength = 200, type = 'text', min, max, area, ...b }: Base & { value: string; onChange: (v: string) => void; maxLength?: number; type?: 'text' | 'number'; min?: number; max?: number; area?: boolean }) {
  const id = useId();
  const common = { id, className: 'lims-input', value, required: b.required, disabled: b.disabled, readOnly: b.readOnly, ...aria(id, b) };
  return (
    <Wrap id={id} {...b}>
      {area ? <textarea {...common} rows={2} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
        : <input {...common} type={type} {...(type === 'number' ? { min, max, step: 1, inputMode: 'numeric' as const } : { maxLength })} onChange={(e) => onChange(e.target.value)} />}
    </Wrap>
  );
}

export function SelectIn({ value, onChange, options, blank, ...b }: Base & { value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; blank?: string }) {
  const id = useId();
  return (
    <Wrap id={id} {...b}>
      <select id={id} className="lims-input" value={value} required={b.required} disabled={b.disabled || b.readOnly} onChange={(e) => onChange(e.target.value)} {...aria(id, b)}>
        {blank !== undefined ? <option value="">{blank}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Wrap>
  );
}

export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="tm-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

/** Messages that have no field on screen, each listed once. */
export function ErrorList({ errors }: { errors: readonly string[] }) {
  return errors.length ? <ul role="alert" className="lims-error catalog-plain-list">{errors.map((m, i) => <li key={i}>{m}</li>)}</ul> : null;
}

/** Server errors keyed by field name (first segment of the pointer); the rest go to `other`. */
export function placeErrors(errors: readonly ServerError[] | undefined, fields: readonly string[]): { at: Record<string, string>; other: string[] } {
  const at: Record<string, string> = {};
  const other: string[] = [];
  for (const e of errors ?? []) {
    const f = pathOf(e).replace(/^\//, '').split('/')[0] ?? '';
    if (fields.includes(f) && !at[f]) at[f] = e.message;
    else other.push(e.message);
  }
  return { at, other };
}

export const GENERIC_FAIL: Record<string, string> = {
  'common.version_conflict': 'Someone else changed this item. Reload to see their changes.',
  'auth.forbidden': 'You do not have permission to do this.',
  'auth.mfa_required': 'This change needs a second factor. Verify your identity, then try again.',
};
export const failText = (code: string) => GENERIC_FAIL[code] ?? 'Could not save. Check the fields and try again.';
