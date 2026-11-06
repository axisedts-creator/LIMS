import type { ComponentProps } from 'react';
import { Focusable, Tooltip as RacTooltip, TooltipTrigger } from 'react-aria-components';

export interface TooltipProps {
  /** Plain text; supplementary only, never the sole carrier of information (04 §5.3). */
  content: string;
  /** One focusable element (opens on keyboard focus and hover; Esc closes). */
  children: ComponentProps<typeof Focusable>['children'];
  placement?: 'top' | 'bottom' | 'start' | 'end';
}

export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  return (
    <TooltipTrigger delay={500}>
      <Focusable>{children}</Focusable>
      <RacTooltip className="lims-tooltip" placement={placement} offset={6}>
        {content}
      </RacTooltip>
    </TooltipTrigger>
  );
}
