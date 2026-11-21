import type { ReactNode } from 'react';
import type { Space } from '../Stack/Stack';

export interface InlineProps {
  children: ReactNode;
  /** Horizontal gap, token space.<n>. Default 2. */
  gap?: Space;
  align?: 'start' | 'center' | 'end' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between';
  wrap?: boolean;
  'data-testid'?: string;
  /** T0D-UIGUARD-1-ANALYTICS (additive, LD-441): a row of chosen items keeps list semantics without a raw ul. */
  role?: 'list' | 'group';
  'aria-label'?: string;
}

const J = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' } as const;
const A = { start: 'flex-start', center: 'center', end: 'flex-end', baseline: 'baseline' } as const;

export function Inline({ children, gap = 2, align = 'center', justify = 'start', wrap = true, ...rest }: InlineProps) {
  return (
    <div
      className="lims-inline"
      style={{ gap: `var(--lims-space-${gap})`, alignItems: A[align], justifyContent: J[justify], flexWrap: wrap ? 'wrap' : 'nowrap' }}
      {...rest}
    >
      {children}
    </div>
  );
}
