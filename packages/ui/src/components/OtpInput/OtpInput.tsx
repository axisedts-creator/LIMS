import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';

/** C6 04-UI-UX:322. */
export interface OtpInputProps {
  label: string;
  length: 6;
  value?: string;
  onChange?: (v: string) => void;
  /** Called when all `length` digits are filled, and on Enter with a complete code (C0 §2.8 "Enter submits"). */
  onComplete?: (v: string) => void;
  error?: string;
  isDisabled?: boolean;
  'data-testid'?: string;
}

const toDigits = (v: string | undefined, length: number) => {
  const d = (v ?? '').replace(/\D/g, '').slice(0, length).split('');
  return Array.from({ length }, (_, i) => d[i] ?? '');
};

/** One input per digit (C2 MFA, C6 portal OTP). Digits only; paste fills from the focused cell. */
export function OtpInput({ label, length, value, onChange, onComplete, error, isDisabled, ...rest }: OtpInputProps) {
  const id = useId();
  const [digits, setDigits] = useState<string[]>(() => toDigits(value, length));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (value !== undefined) setDigits(toDigits(value, length));
  }, [value, length]);

  const commit = (next: string[]) => {
    setDigits(next);
    const v = next.join('');
    onChange?.(v);
    if (v.length === length) onComplete?.(v);
  };
  const fill = (from: number, text: string) => {
    const incoming = text.replace(/\D/g, '').slice(0, length - from).split('');
    if (!incoming.length) return;
    const next = [...digits];
    incoming.forEach((d, k) => (next[from + k] = d));
    commit(next);
    refs.current[Math.min(from + incoming.length, length - 1)]?.focus();
  };
  const clear = (i: number) => {
    if (!digits[i]) return;
    const next = [...digits];
    next[i] = '';
    commit(next);
  };
  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = digits.join('');
      if (v.length === length) onComplete?.(v);
    } else if (e.key === 'Backspace' && !digits[i] && i > 0) {
      e.preventDefault();
      clear(i - 1);
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
  };

  return (
    <div className="lims-field" {...rest}>
      <span id={`${id}-l`} className="lims-label">
        {label}
      </span>
      <div role="group" aria-labelledby={`${id}-l`} aria-describedby={error ? `${id}-e` : undefined} className="lims-otp">
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
            onChange={(e) => {
              if (isDisabled) return;
              const v = e.target.value.replace(/\D/g, '');
              if (v === '') clear(i);
              else fill(i, v.length > 1 && d && v.startsWith(d) ? v.slice(d.length) : v);
            }}
            onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
              e.preventDefault();
              if (!isDisabled) fill(i, e.clipboardData.getData('text'));
            }}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => onKeyDown(i, e)}
          />
        ))}
      </div>
      {error ? (
        <span id={`${id}-e`} className="lims-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
