import { Button } from '../Button/Button';
import type { IconName } from '../Icon/Icon';
import { StateArt } from '../_shared/StateArt';

export interface EmptyStateProps {
  title: string;
  body?: string;
  /** A button (`onPress`) or, for a create action that is a page link, a link styled as the primary button (`href`, T0D-EMPTYTBL-2 / LD-336). */
  action?: { label: string; onPress: () => void } | { label: string; href: string };
  /** @deprecated T0D-UIKIT-2 (LD-436 R16): the state now carries its drawn illustration; kept so callers still compile. */
  icon?: IconName;
  'data-testid'?: string;
}

export function EmptyState({ title, body, action, icon: _icon, ...rest }: EmptyStateProps) {
  return (
    <div className="lims-state" {...rest}>
      <StateArt kind="empty" />
      <p className="lims-state-title">{title}</p>
      {body ? <p className="lims-state-body">{body}</p> : null}
      {action && 'href' in action ? (
        <a className="lims-btn lims-btn-primary lims-btn-md" href={action.href}>{action.label}</a>
      ) : action ? (
        <Button variant="primary" onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
