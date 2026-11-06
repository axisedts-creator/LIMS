import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { FieldBase } from '../_shared/TextInputBase';

export interface OtpInputProps extends FieldBase {
  onChange?: (v: string) => void;
  /** Called on Enter only when all `length` digits are present. */
  onSubmit?: (v: string) => void;
  /** Default 6. */
  length?: number;
}

/** One input per digit (C2 MFA, C6 portal OTP). Digits only; paste fills from the focused cell. */
export function OtpInput({ label, name, description, error, isRequired, isDisabled, isReadOnly, onChange, onSubmit, length = 6, ...rest }: OtpInputProps) {
  const id = useId();
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(''));
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const locked = !!(isDisabled || isReadOnly);

  const fill = (from: number, text: string) => {
    const incoming = text.replace(/\D/g, '').slice(0, length - from).split('');
    if (!incoming.length) return;
    const next = [...digits];
    incoming.forEach((d, k) => (next[from + k] = d));
    setDigits(next);
    onChange?.(next.join(''));
    refs.current[Math.min(from + incoming.length, length - 1)]?.focus();
  };
  const clear = (i: number) => {
    if (!digits[i]) return;
    const next = [...digits];
    next[i] = '';
    setDigits(next);
    onChange?.(next.join(''));
  };
  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = digits.join('');
      if (v.length === length) onSubmit?.(v);
    } else if (e.key === 'Backspace' && !digits[i] && i > 0) {
      e.preventDefault();
      clear(i - 1);
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
  };
  const describedBy = [description ? `${id}-d` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className="lims-field" {...rest}>
      <span id={`${id}-l`} className="lims-label">
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </span>
      <div role="group" aria-labelledby={`${id}-l`} aria-describedby={describedBy} className="lims-otp">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="lims-input lims-otp-cell lims-mono"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            aria-label={`Digit ${i + 1} of ${length}`}
            aria-invalid={error ? true : undefined}
            value={d}
            disabled={isDisabled}
            readOnly={isReadOnly}
            onChange={(e) => {
              if (locked) return;
              const v = e.target.value.replace(/\D/g, '');
              if (v === '') clear(i);
              else fill(i, v.length > 1 && d && v.startsWith(d) ? v.slice(d.length) : v);
            }}
            onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
              e.preventDefault();
              if (!locked) fill(i, e.clipboardData.getData('text'));
            }}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => onKeyDown(i, e)}
          />
        ))}
      </div>
      <input type="hidden" name={name} value={digits.join('')} />
      {description ? (
        <span id={`${id}-d`} className="lims-description">
          {description}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-e`} className="lims-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
