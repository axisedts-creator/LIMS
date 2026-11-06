import type { CSSProperties, ReactNode } from 'react';

const style: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Text for assistive tech only. */
export function VisuallyHidden({ children, id, ...rest }: { children: ReactNode; id?: string; 'data-testid'?: string }) {
  return (
    <span style={style} {...(id ? { id } : {})} {...rest}>
      {children}
    </span>
  );
}
