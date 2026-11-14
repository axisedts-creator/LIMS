'use client';
// Native number input with a visible label. [CONV] The kit's IntegerField/DecimalField expose the range only as aria-valuemin/max; the reporting
// forms need the native min/max/step constraints (and browser spinners), so range fields use this thin wrapper over the kit's field classes.
import { useId } from 'react';

export interface NumberInputProps {
  label: string; name: string; value: number | ''; onChange: (v: number | '') => void; min: number; max: number; step?: number;
  isDisabled?: boolean; isReadOnly?: boolean; description?: string;
}

/** Error text for a value outside [min,max] (or not a whole number when step is 1); undefined when valid. */
export const rangeError = (label: string, v: number | '', min: number, max: number, step = 1) =>
  v === '' || !Number.isFinite(v) || v < min || v > max || (step === 1 && !Number.isInteger(v)) ? `${label} must be between ${min} and ${max}` : undefined;

export function NumberInput({ label, name, value, onChange, min, max, step = 1, isDisabled, isReadOnly, description }: NumberInputProps) {
  const id = useId();
  const error = rangeError(label, value, min, max, step);
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}</label>
      <input
        id={id} name={name} type="number" className="lims-input" min={min} max={max} step={step} value={value} disabled={isDisabled} readOnly={isReadOnly}
        aria-invalid={error ? true : undefined} aria-describedby={[description ? `${id}-d` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined}
        onChange={(e) => onChange(e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))}
      />
      {description ? <p id={`${id}-d`} className="lims-description">{description}</p> : null}
      {error ? <p id={`${id}-e`} className="lims-error">{error}</p> : null}
    </div>
  );
}
