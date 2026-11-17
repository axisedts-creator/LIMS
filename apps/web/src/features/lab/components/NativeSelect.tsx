'use client';
// Native <select> with a label: the list sits inside the dialog / page and keyboard + AT users get the platform control (same reason as reporting/ReasonDialog; the kit Select is a popover listbox).
import { useId } from 'react';

export function NativeSelect({ label, value, onChange, options, error, placeholder = 'Select…', name }: {
  label: string; value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; error?: string | undefined; placeholder?: string | null; name?: string;
}) {
  const id = useId();
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}</label>
      <select id={id} name={name} className="lims-input" value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined} onChange={(e) => onChange(e.currentTarget.value)}>
        {placeholder === null ? null : <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error ? <p id={`${id}-e`} className="lims-error">{error}</p> : null}
    </div>
  );
}
