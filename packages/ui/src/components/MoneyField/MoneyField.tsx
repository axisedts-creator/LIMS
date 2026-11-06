import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';
import { useEditText } from '../_shared/useEditText';
import { formatPaisa, parseRupees } from '../_shared/decimal';
import { msg } from '../_shared/messages';

/** IC money: integer paisa + ISO currency (NPR only in v1). */
export interface Money {
  amount_paisa: number;
  currency: 'NPR';
}

export interface MoneyFieldProps extends FieldBase {
  value?: Money;
  onChange?: (v: Money | undefined) => void;
  min?: Money;
  max?: Money;
  /** Default false. */
  allowNegative?: boolean;
}

const same = (a?: Money, b?: Money) => a?.amount_paisa === b?.amount_paisa;
const toText = (m: Money) => formatPaisa(m.amount_paisa, 'lakh');

export function MoneyField({ value, onChange, min, max, allowNegative = false, ...rest }: MoneyFieldProps) {
  const { text, set } = useEditText(value, toText, same);
  const pattern = allowNegative ? /^-?[\d,]*(\.\d{0,2})?$/ : /^[\d,]*(\.\d{0,2})?$/;
  return (
    <TextInputBase
      {...rest}
      inputMode="decimal"
      prefix="Rs."
      text={text}
      onText={(raw) => {
        const t = raw.trim();
        if (!pattern.test(t)) return;
        const p = parseRupees(t);
        set(t, p === undefined ? undefined : { amount_paisa: p, currency: 'NPR' }, onChange);
      }}
      validate={(t) => {
        const p = parseRupees(t);
        if (p === undefined) return msg.decimals(rest.label, 2);
        if ((min && p < min.amount_paisa) || (max && p > max.amount_paisa))
          return msg.range(rest.label, min ? formatPaisa(min.amount_paisa) : '…', max ? formatPaisa(max.amount_paisa) : '…');
        return undefined;
      }}
    />
  );
}
