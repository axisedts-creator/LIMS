import { Button } from '../Button/Button';
import { Icon } from '../Icon/Icon';
import { PageHeader } from '../PageHeader/PageHeader';
import { msg } from '../_shared/messages';

export interface ErrorStateProps {
  title: string;
  body?: string;
  /** Shown as 'Reference: xxxxxxxx'. */
  requestId?: string;
  onRetry?: () => void;
  /** T0D-UIKIT-1, LD-353 rule 6: the page keeps its title on error; when given, the h1 is rendered above the state. */
  pageTitle?: string;
  'data-testid'?: string;
}

export function ErrorState({ title, body, requestId, onRetry, pageTitle, ...rest }: ErrorStateProps) {
  const state = (
    <div className="lims-state lims-tone-danger" data-tone="danger" {...rest}>
      <Icon name="danger" size={32} />
      <p className="lims-state-title">{title}</p>
      {body ? <p className="lims-state-body">{body}</p> : null}
      {requestId ? <p className="lims-state-ref">{msg.reference(requestId)}</p> : null}
      {onRetry ? <Button onPress={onRetry}>{msg.retry}</Button> : null}
    </div>
  );
  return pageTitle ? (
    <>
      <PageHeader title={pageTitle} helpKey="core.shell.error" />
      {state}
    </>
  ) : (
    state
  );
}
