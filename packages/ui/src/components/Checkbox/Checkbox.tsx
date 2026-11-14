import { useId } from 'react';
import { Checkbox as RacCheckbox } from 'react-aria-components';
import { Icon } from '../Icon/Icon';

export interface CheckboxProps {
  label: string;
  isSelected?: boolean;
  onChange?: (v: boolean) => void;
  isDisabled?: boolean;
  description?: string;
  name?: string;
  'data-testid'?: string;
}

export function Checkbox({ label, isSelected, onChange, isDisabled, description, name, ...rest }: CheckboxProps) {
  const descId = useId();
  return (
    <div className="lims-check-wrap" {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}>
      <RacCheckbox
        className="lims-check"
        {...(isSelected !== undefined ? { isSelected } : {})}
        {...(onChange ? { onChange } : {})}
        {...(isDisabled ? { isDisabled: true } : {})}
        {...(name ? { name } : {})}
        {...(description ? { 'aria-describedby': descId } : {})}
      >
        {({ isSelected: on }) => (
          <>
            <span className="lims-check-box" aria-hidden="true">
              {on ? <Icon name="check" size={12} /> : null}
            </span>
            {label}
          </>
        )}
      </RacCheckbox>
      {description ? (
        <span id={descId} className="lims-description">
          {description}
        </span>
      ) : null}
    </div>
  );
}
