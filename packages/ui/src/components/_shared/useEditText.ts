import { useRef, useState } from 'react';

/**
 * Text state for a field whose value is not a string (number, DecimalString, Money).
 * The text follows the `value` prop unless the change came from this field (so partial input like "12." survives).
 */
export function useEditText<V>(value: V | undefined, toText: (v: V) => string, same: (a: V | undefined, b: V | undefined) => boolean) {
  const [text, setText] = useState(() => (value === undefined ? '' : toText(value)));
  const emitted = useRef<{ v: V | undefined } | null>(null);
  const seen = useRef(value);
  if (!same(seen.current, value)) {
    seen.current = value;
    if (!emitted.current || !same(emitted.current.v, value)) {
      const t = value === undefined ? '' : toText(value);
      if (t !== text) setText(t);
    }
  }
  return {
    text,
    set(t: string, v: V | undefined, emit?: (v: V | undefined) => void) {
      setText(t);
      emitted.current = { v };
      seen.current = v;
      emit?.(v);
    },
  };
}
