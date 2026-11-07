import { forwardRef } from 'react';
import { msg } from '../_shared/messages';

export interface ErrorSummaryItem {
  message: string;
  /** Present when the error belongs to a field on the page; renders a link that focuses it. */
  focus?: () => void;
}

export const ErrorSummary = forwardRef<HTMLDivElement, { items: readonly ErrorSummaryItem[] }>(function ErrorSummary({ items }, ref) {
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="lims-error-summary" data-testid="error-summary">
      <p className="lims-error-summary-title">{msg.errorSummaryTitle}</p>
      <ul>
        {items.map((it, i) => (
          <li key={i}>
            {it.focus ? (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  it.focus?.();
                }}
              >
                {it.message}
              </a>
            ) : (
              it.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
});
