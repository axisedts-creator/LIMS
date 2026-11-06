import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';
import { useEditText } from '../_shared/useEditText';
import { formatPaisa, parseRupees } from '../_shared/decimal';
import { msg } from '../_shared/messages';

/** 03-INTERFACE-CATALOG Money: integer paisa + currency (NPR only in v1). */
// ponytail: local copy until @lims/shared-ts/types exports Money (0A)
export interface Money {
  readonly amountPaisa: number;
  readonly currency: 'NPR';
}

export interface MoneyFieldProps extends FieldBase {
  value?: Money;
  onChange?: (v: Money | undefined) => void;
  min?: Money;
  max?: Money;
  /** Default false. */
  allowNegative?: boolean;
}

const same = (a?: Money, b?: Money) => a?.amountPaisa === b?.amountPaisa;
const toText = (m: Money) => formatPaisa(m.amountPaisa, 'lakh');

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
        set(t, p === undefined ? undefined : { amountPaisa: p, currency: 'NPR' }, onChange);
      }}
      validate={(t) => {
        const p = parseRupees(t);
        if (p === undefined) return msg.decimals(rest.label, 2);
        if ((min && p < min.amountPaisa) || (max && p > max.amountPaisa))
          return msg.range(rest.label, min ? formatPaisa(min.amountPaisa) : '…', max ? formatPaisa(max.amountPaisa) : '…');
        return undefined;
      }}
    />
  );
}
