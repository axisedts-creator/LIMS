import type { ReactNode } from 'react';
import type { Space } from '../Stack/Stack';

export interface GridProps {
  children: ReactNode;
  /** Columns at md and up; one column below md (04 §6). Default 2. */
  columns?: 1 | 2 | 3 | 4;
  gap?: Space;
  'data-testid'?: string;
}

export function Grid({ children, columns = 2, gap = 4, ...rest }: GridProps) {
  return (
    <div className={`lims-grid lims-cols-${columns}`} style={{ gap: `var(--lims-space-${gap})` }} {...rest}>
      {children}
    </div>
  );
}
