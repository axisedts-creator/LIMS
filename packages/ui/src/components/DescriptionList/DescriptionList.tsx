import type { ReactNode } from 'react';

export interface DescriptionListProps {
  items: readonly { term: string; value: ReactNode }[];
  columns?: 1 | 2 | 3;
  'data-testid'?: string;
}

export function DescriptionList({ items, columns = 1, ...rest }: DescriptionListProps) {
  return (
    <dl className={`lims-dl lims-cols-${columns}`} {...rest}>
      {items.map((it, i) => (
        <div key={i} className="lims-dl-item">
          <dt>{it.term}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
