import { Switch as RacSwitch } from 'react-aria-components';

export interface SwitchProps {
  label: string;
  isSelected?: boolean;
  onChange?: (v: boolean) => void;
  isDisabled?: boolean;
  name?: string;
  'data-testid'?: string;
}

export function Switch({ label, isSelected, onChange, isDisabled, name, ...rest }: SwitchProps) {
  return (
    <RacSwitch
      className="lims-switch"
      {...(isSelected !== undefined ? { isSelected } : {})}
      {...(onChange ? { onChange } : {})}
      {...(isDisabled ? { isDisabled: true } : {})}
      {...(name ? { name } : {})}
      {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
    >
      <span className="lims-switch-track" aria-hidden="true">
        <span className="lims-switch-thumb" />
      </span>
      {label}
    </RacSwitch>
  );
}
