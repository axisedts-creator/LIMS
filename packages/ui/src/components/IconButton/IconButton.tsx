import { Button as RacButton } from 'react-aria-components';
import { Icon, type IconName } from '../Icon/Icon';

export interface IconButtonProps {
  /** Required accessible name. */
  label: string;
  icon: IconName;
  variant?: 'ghost' | 'secondary';
  onPress: () => void;
  'data-testid'?: string;
}

export function IconButton({ label, icon, variant = 'ghost', onPress, ...rest }: IconButtonProps) {
  return (
    <RacButton
      aria-label={label}
      className={`lims-btn lims-btn-${variant} lims-icon-btn`}
      onPress={onPress}
      {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
    >
      <Icon name={icon} />
    </RacButton>
  );
}
