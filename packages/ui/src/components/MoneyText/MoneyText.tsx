import type { Money } from '../MoneyField/MoneyField';
import { formatPaisa } from '../_shared/decimal';

export interface MoneyTextProps {
  value: Money;
  /** Default 'lakh' (12,34,567.89). */
  grouping?: 'lakh' | 'international';
  'data-testid'?: string;
}

export function MoneyText({ value, grouping = 'lakh', ...rest }: MoneyTextProps) {
  return (
    <span className="lims-money" {...rest}>
      Rs. {formatPaisa(value.amountPaisa, grouping)}
    </span>
  );
}
