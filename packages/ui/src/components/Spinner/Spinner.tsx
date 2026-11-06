import { Icon } from '../Icon/Icon';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import { msg } from '../_shared/messages';

export interface SpinnerProps {
  /** Default msg.loading. */
  label?: string;
  /** false inside a control that already announces state (e.g. Button with aria-busy). Default true. */
  asStatus?: boolean;
  'data-testid'?: string;
}

export function Spinner({ label = msg.loading, asStatus = true, ...rest }: SpinnerProps) {
  return (
    <span className="lims-spinner" {...(asStatus ? { role: 'status' } : {})} {...rest}>
      <Icon name="spinner" className="lims-spin" />
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}
