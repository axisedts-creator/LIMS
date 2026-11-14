import { forwardRef, type ReactNode } from 'react';
import { Button as RacButton } from 'react-aria-components';
import { Icon, type IconName } from '../Icon/Icon';
import { Spinner } from '../Spinner/Spinner';
import { msg } from '../_shared/messages';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  type?: 'button' | 'submit';
  isLoading?: boolean;
  isDisabled?: boolean;
  iconStart?: IconName;
  /** Shown as a hint, e.g. 'Ctrl+Enter'. */
  shortcut?: string;
  onPress?: () => void;
  children: ReactNode;
  'data-testid'?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', type = 'button', isLoading, isDisabled, iconStart, shortcut, onPress, children, ...rest },
  ref,
) {
  return (
    <RacButton
      ref={ref}
      type={type}
      className={`lims-btn lims-btn-${variant} lims-btn-${size}`}
      isDisabled={!!(isDisabled || isLoading)}
      {...(onPress ? { onPress } : {})}
      {...(shortcut ? { 'aria-keyshortcuts': shortcut.replace(/Ctrl/g, 'Control') } : {})}
      {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
      {...(isLoading ? { 'aria-busy': true } : {})}
    >
      {isLoading ? (
        <Spinner label={msg.working} asStatus={false} />
      ) : iconStart ? (
        <Icon name={iconStart} />
      ) : null}
      <span className="lims-btn-label">{children}</span>
      {shortcut ? (
        <kbd className="lims-kbd" aria-hidden="true">
          {shortcut}
        </kbd>
      ) : null}
    </RacButton>
  );
});
