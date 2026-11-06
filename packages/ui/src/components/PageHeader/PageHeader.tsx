import type { ReactNode } from 'react';
import { Button } from '../Button/Button';
import { msg } from '../_shared/messages';

export interface PageHeaderProps {
  title: string;
  breadcrumbs?: readonly { label: string; href?: string }[];
  actions?: ReactNode;
  status?: ReactNode;
  /** REQUIRED: in-app help (CV §14). */
  helpKey: string;
  /** [CONV] Called with helpKey when the help control is pressed; the web shell opens its help panel. */
  onHelp?: (helpKey: string) => void;
  'data-testid'?: string;
}

/** Only relative or same-origin http(s) hrefs; anything else (javascript:, data:) renders as plain text. */
const safeHref = (h?: string) => (h && /^(\/(?!\/)|#|\?|https?:\/\/)/i.test(h) ? h : undefined);

export function PageHeader({ title, breadcrumbs, actions, status, helpKey, onHelp, ...rest }: PageHeaderProps) {
  return (
    <div className="lims-page-header" {...rest}>
      {breadcrumbs?.length ? (
        <nav aria-label={msg.breadcrumb} className="lims-breadcrumbs">
          <ol>
            {breadcrumbs.map((b, i) => {
              const last = i === breadcrumbs.length - 1;
              const href = safeHref(b.href);
              return (
                <li key={i}>
                  {last ? <span aria-current="page">{b.label}</span> : href ? <a href={href}>{b.label}</a> : <span>{b.label}</span>}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="lims-page-header-row">
        <h1 className="lims-page-title">{title}</h1>
        {status ? <div className="lims-page-status">{status}</div> : null}
        <div className="lims-page-actions">
          {actions}
          <span data-help-key={helpKey}>
            <Button variant="ghost" iconStart="help" onPress={() => onHelp?.(helpKey)}>
              {msg.help}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
