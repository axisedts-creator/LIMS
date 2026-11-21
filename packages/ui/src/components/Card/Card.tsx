import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  /** Optional heading; rendered as h2 (the page owns the single h1). */
  title?: string;
  /** T0D-UIKIT-2 (LD-436 Card title row): one short caption on the right of the title. Needs a title. */
  caption?: string;
  /** T0D-UIGUARD-1-CATALOG (additive, LD-441): the card is a <section> region named by its title (a page section with its own heading). Needs a title. */
  region?: boolean;
  'data-testid'?: string;
}

export function Card({ children, title, caption, region = false, ...rest }: CardProps) {
  const body = (
    <>
      {title ? (
        <div className="lims-card-head">
          <h2 className="lims-card-title">{title}</h2>
          {caption ? <span className="lims-card-caption">{caption}</span> : null}
        </div>
      ) : null}
      {children}
    </>
  );
  return region && title ? (
    <section className="lims-card" aria-label={title} {...rest}>{body}</section>
  ) : (
    <div className="lims-card" {...rest}>{body}</div>
  );
}
