import type { ReactNode } from 'react';
import { OverlayFrame } from '../Dialog/Dialog';

export interface DrawerProps {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  side?: 'end' | 'start';
  width?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  'data-testid'?: string;
}

export function Drawer({ side = 'end', width = 'md', 'data-testid': testId, ...rest }: DrawerProps) {
  return <OverlayFrame kind="drawer" className={`lims-drawer lims-drawer-${side} lims-drawer-${width}`} testId={testId} {...rest} />;
}
