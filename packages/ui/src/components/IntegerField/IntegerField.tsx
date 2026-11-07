import type { KeyboardEvent } from 'react';
import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';
import { useEditText } from '../_shared/useEditText';
import { msg } from '../_shared/messages';

export interface IntegerFieldProps extends FieldBase {
  value?: number;
  onChange?: (v: number | undefined) => void;
  min: number;
  max: number;
  step?: number;
}

const same = (a?: number, b?: number) => a === b;

export function IntegerField({ value, onChange, min, max, step = 1, ...rest }: IntegerFieldProps) {
  const { text, set } = useEditText(value, String, same);
  const current = text === '' || text === '-' ? undefined : Number(text);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const pattern = min < 0 ? /^-?\d*$/ : /^\d*$/;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const d = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
    if (!d || rest.isReadOnly || rest.isDisabled) return;
    e.preventDefault();
    const n = clamp(current === undefined ? min : current + d);
    set(String(n), n, onChange);
  };

  return (
    <TextInputBase
      {...rest}
      inputMode="numeric"
      text={text}
      onText={(raw) => {
        const t = raw.trim();
        if (!pattern.test(t)) return;
        set(t, t === '' || t === '-' ? undefined : Number(t), onChange);
      }}
      validate={(t) => {
        const n = Number(t);
        return Number.isInteger(n) && n >= min && n <= max ? undefined : msg.range(rest.label, String(min), String(max));
      }}
      onKeyDown={onKeyDown}
      inputProps={{
        role: 'spinbutton',
        'aria-valuemin': min,
        'aria-valuemax': max,
        ...(current !== undefined && Number.isFinite(current) ? { 'aria-valuenow': current } : {}),
      }}
    />
  );
}
