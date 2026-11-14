'use client';
// ponytail: local PasswordField (show/hide toggle, 04-UI-UX §2.1) — the kit has no PasswordField yet; swap for
// @lims/ui/components/PasswordField once it ships.
import { useId, useState } from 'react';
import { Button } from '@lims/ui/components/Button';

export interface PasswordFieldProps {
  label: string;
  name: string;
  autoComplete: 'current-password' | 'new-password';
  maxLength: number;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  isDisabled?: boolean;
}

export function PasswordField({ label, name, autoComplete, maxLength, value, onChange, error, isDisabled }: PasswordFieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>
        {label}
      </label>
      <div className="lims-input-group">
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
        <Button variant="ghost" size="sm" onPress={() => setShown((s) => !s)}>
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
      {error ? (
        <span id={`${id}-e`} className="lims-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
