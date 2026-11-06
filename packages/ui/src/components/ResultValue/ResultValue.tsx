import { FlagBadge, type ResultFlag } from '../FlagBadge/FlagBadge';
import { padDecimal } from '../_shared/decimal';

export interface ResultValueProps {
  value?: string | undefined;
  flag?: ResultFlag;
  unit?: string;
  decimals?: number;
  'data-testid'?: string;
}

/** Abnormal -> bold value + text flag (00 §4). Numbers stay strings: padding only, never float rounding. */
export function ResultValue({ value, flag, unit, decimals, ...rest }: ResultValueProps) {
  const abnormal = !!flag && flag !== 'N';
  const shown = value === undefined ? '—' : decimals !== undefined ? padDecimal(value, decimals) : value;
  return (
    <span className={abnormal ? 'lims-result lims-result-abnormal' : 'lims-result'} {...rest}>
      <span className="lims-result-value">{shown}</span>
      {unit ? <span className="lims-result-unit"> {unit}</span> : null}
      {abnormal ? (
        <>
          {' '}
          <FlagBadge flag={flag} />
        </>
      ) : null}
    </span>
  );
}
