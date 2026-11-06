import type { ReactNode } from 'react';

export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8;

export interface StackProps {
  children: ReactNode;
  /** Vertical gap, token space.<n>. Default 4. */
  gap?: Space;
  'data-testid'?: string;
}

export function Stack({ children, gap = 4, ...rest }: StackProps) {
  return (
    <div className="lims-stack" style={{ gap: `var(--lims-space-${gap})` }} {...rest}>
      {children}
    </div>
  );
}
