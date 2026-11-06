import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  /** Optional heading; rendered as h2 (the page owns the single h1). */
  title?: string;
  'data-testid'?: string;
}

export function Card({ children, title, ...rest }: CardProps) {
  return (
    <div className="lims-card" {...rest}>
      {title ? <h2 className="lims-card-title">{title}</h2> : null}
      {children}
    </div>
  );
}
