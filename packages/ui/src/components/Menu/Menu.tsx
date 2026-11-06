import { useState, type ReactNode } from 'react';
import { useRestoreFocus } from '../_shared/useRestoreFocus';
import { Menu as RacMenu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { Icon, type IconName } from '../Icon/Icon';

export interface MenuProps {
  /** A kit Button (or any react-aria button). */
  trigger: ReactNode;
  items: readonly { id: string; label: string; icon?: IconName; isDanger?: boolean; isDisabled?: boolean }[];
  onAction: (id: string) => void;
  'data-testid'?: string;
}

export function Menu({ trigger, items, onAction, ...rest }: MenuProps) {
  const [isOpen, setOpen] = useState(false);
  useRestoreFocus(isOpen);
  return (
    <MenuTrigger isOpen={isOpen} onOpenChange={setOpen}>
      {trigger}
      <Popover className="lims-popover">
        <RacMenu
          className="lims-menu"
          disabledKeys={items.filter((i) => i.isDisabled).map((i) => i.id)}
          onAction={(k) => onAction(String(k))}
          {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
        >
          {items.map((i) => (
            <MenuItem key={i.id} id={i.id} textValue={i.label} className={i.isDanger ? 'lims-menuitem lims-danger' : 'lims-menuitem'}>
              {i.icon ? <Icon name={i.icon} /> : null}
              {i.label}
            </MenuItem>
          ))}
        </RacMenu>
      </Popover>
    </MenuTrigger>
  );
}
