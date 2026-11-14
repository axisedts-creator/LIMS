import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';
import { useEditText } from '../_shared/useEditText';
import { cmpDecimal, fractionDigits, isDecimal } from '../_shared/decimal';
import { msg } from '../_shared/messages';

/** Decimal number as a string (never a float). */
export type DecimalString = string;

export interface DecimalFieldProps extends FieldBase {
  value?: DecimalString;
  onChange?: (v: DecimalString | undefined) => void;
  /** Max fraction digits, from the catalog analyte. */
  decimals: number;
  min?: DecimalString;
  max?: DecimalString;
  allowNegative?: boolean;
  /** Unit hint (CR-C12-009). */
  suffix?: string;
}

const same = (a?: string, b?: string) => a === b;
const id = (s: string) => s;

export function DecimalField({ value, onChange, decimals, min, max, allowNegative = false, ...rest }: DecimalFieldProps) {
  const { text, set } = useEditText(value, id, same);
  const pattern = allowNegative ? /^-?\d*(\.\d*)?$/ : /^\d*(\.\d*)?$/;
  return (
    <TextInputBase
      {...rest}
      inputMode="decimal"
      text={text}
      onText={(raw) => {
        const t = raw.trim();
        if (!pattern.test(t)) return;
        if (t === '') return set(t, undefined, onChange);
        // partial input ("12.", "-") stays on screen but is not emitted
        if (isDecimal(t)) set(t, t, onChange);
        else set(t, value);
      }}
      validate={(t) => {
        if (!isDecimal(t)) return msg.decimals(rest.label, decimals);
        if (fractionDigits(t) > decimals) return msg.decimals(rest.label, decimals);
        if ((min !== undefined && cmpDecimal(t, min) < 0) || (max !== undefined && cmpDecimal(t, max) > 0))
          return msg.range(rest.label, min ?? '…', max ?? '…');
        return undefined;
      }}
    />
  );
}
