import { useState, type ComponentProps, type ReactNode } from 'react';
import { Dialog, DialogTrigger, Heading, Popover as RacPopover, Pressable } from 'react-aria-components';
import { useRestoreFocus } from '../_shared/useRestoreFocus';

export interface PopoverProps {
  /** One pressable element that toggles the popover. */
  trigger: ComponentProps<typeof Pressable>['children'];
  /** Accessible name of the popover dialog (rendered as its heading). */
  title: string;
  children: ReactNode;
  placement?: 'top' | 'bottom' | 'start' | 'end';
  'data-testid'?: string;
}

/** Non-blocking dialog anchored to its trigger: focus contained, Esc / outside click closes, focus returns (04 §5.3). */
export function Popover({ trigger, title, children, placement = 'bottom', 'data-testid': testId }: PopoverProps) {
  const [isOpen, setOpen] = useState(false);
  useRestoreFocus(isOpen);
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <Pressable>{trigger}</Pressable>
      <RacPopover className="lims-popover lims-popover-panel" placement={placement}>
        <Dialog className="lims-popover-body" {...(testId ? { 'data-testid': testId } : {})}>
          <Heading slot="title" className="lims-popover-title">
            {title}
          </Heading>
          {children}
        </Dialog>
      </RacPopover>
    </DialogTrigger>
  );
}
