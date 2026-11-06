import { Button } from '../Button/Button';
import { Icon } from '../Icon/Icon';
import { msg } from '../_shared/messages';

export interface ErrorStateProps {
  title: string;
  body?: string;
  /** Shown as 'Reference: xxxxxxxx'. */
  requestId?: string;
  onRetry?: () => void;
  'data-testid'?: string;
}

export function ErrorState({ title, body, requestId, onRetry, ...rest }: ErrorStateProps) {
  return (
    <div className="lims-state lims-tone-danger" data-tone="danger" {...rest}>
      <Icon name="danger" size={32} />
      <p className="lims-state-title">{title}</p>
      {body ? <p className="lims-state-body">{body}</p> : null}
      {requestId ? <p className="lims-state-ref">{msg.reference(requestId)}</p> : null}
      {onRetry ? <Button onPress={onRetry}>{msg.retry}</Button> : null}
    </div>
  );
}
