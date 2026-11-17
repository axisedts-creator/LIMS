'use client';
// ponytail: local PasswordField (show/hide toggle, 04-UI-UX §2.1) — the kit has no PasswordField yet; swap for
// @lims/ui/components/PasswordField once C0-0D ships it.
import { useId, useState, type ReactNode } from 'react';
import { RequiredNote } from '../ui';
import { AuthIcon } from './AuthArt';

export interface PasswordFieldProps {
  label: string;
  name: string;
  autoComplete: 'current-password' | 'new-password';
  maxLength: number;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  isDisabled?: boolean;
  /** T0D-MSERIES-5 (board M1-entry): an element on the label row, e.g. the sign-in screen's Forgot password? link. */
  labelAction?: ReactNode;
}

export function PasswordField({ label, name, autoComplete, maxLength, value, onChange, error, isDisabled, labelAction }: PasswordFieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="lims-field">
      <div className="lims-label-row">
        <label className="lims-label" htmlFor={id}>
          {label}
        </label>
        <RequiredNote />
        {labelAction}
      </div>
      <div className="lims-input-wrap">
        <AuthIcon kind="lock" className="lims-input-icon" />
        <input
          id={id}
          className="lims-input"
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          maxLength={maxLength}
          required
          value={value}
          disabled={isDisabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="lims-btn lims-btn-ghost lims-btn-sm lims-input-toggle" aria-pressed={shown} onClick={() => setShown((s) => !s)}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {error ? (
        <span id={`${id}-e`} className="lims-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
