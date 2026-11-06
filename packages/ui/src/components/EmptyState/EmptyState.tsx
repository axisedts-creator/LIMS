import { Button } from '../Button/Button';
import { Icon, type IconName } from '../Icon/Icon';

export interface EmptyStateProps {
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  icon?: IconName;
  'data-testid'?: string;
}

export function EmptyState({ title, body, action, icon = 'empty', ...rest }: EmptyStateProps) {
  return (
    <div className="lims-state" {...rest}>
      <Icon name={icon} size={32} />
      <p className="lims-state-title">{title}</p>
      {body ? <p className="lims-state-body">{body}</p> : null}
      {action ? (
        <Button variant="primary" onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
