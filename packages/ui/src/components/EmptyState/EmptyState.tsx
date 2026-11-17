import { Button } from '../Button/Button';
import { Icon, type IconName } from '../Icon/Icon';

export interface EmptyStateProps {
  title: string;
  body?: string;
  /** A button (`onPress`) or, for a create action that is a page link, a link styled as the primary button (`href`, T0D-EMPTYTBL-2 / LD-336). */
  action?: { label: string; onPress: () => void } | { label: string; href: string };
  icon?: IconName;
  'data-testid'?: string;
}

export function EmptyState({ title, body, action, icon = 'empty', ...rest }: EmptyStateProps) {
  return (
    <div className="lims-state" {...rest}>
      <Icon name={icon} size={32} />
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
