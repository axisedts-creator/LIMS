import type { ReactNode } from 'react';
import { Button } from '../Button/Button';
import { Icon } from '../Icon/Icon';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import { msg, type Tone } from '../_shared/messages';

export interface BannerProps {
  tone: Tone;
  title: string;
  children?: ReactNode;
  action?: { label: string; onPress: () => void };
  'data-testid'?: string;
}

const icon = (t: Tone) => (t === 'success' ? 'check' : t === 'neutral' ? 'info' : t);

export function Banner({ tone, title, children, action, ...rest }: BannerProps) {
  return (
    <div className={`lims-banner lims-tone-${tone}`} data-tone={tone} {...rest}>
      <Icon name={icon(tone)} />
      <div className="lims-banner-text">
        <p className="lims-banner-title">
          <VisuallyHidden>{msg.toneText[tone]}: </VisuallyHidden>
          {title}
        </p>
        {children ? <div className="lims-banner-body">{children}</div> : null}
      </div>
      {action ? (
        <Button size="sm" onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
