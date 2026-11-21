import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  /** Optional heading; rendered as h2 (the page owns the single h1). */
  title?: string;
  /** T0D-UIKIT-2 (LD-436 Card title row): one short caption on the right of the title. Needs a title. */
  caption?: string;
  'data-testid'?: string;
}

export function Card({ children, title, caption, ...rest }: CardProps) {
  return (
    <div className="lims-card" {...rest}>
      {title ? (
        <div className="lims-card-head">
          <h2 className="lims-card-title">{title}</h2>
          {caption ? <span className="lims-card-caption">{caption}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
