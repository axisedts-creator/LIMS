import { useId, type ReactNode } from 'react';
import { Button } from '../Button/Button';
import { OverlayFrame } from '../Dialog/Dialog';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';

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

export interface DrawerSectionProps {
  title: string;
  onSave: () => void;
  isSaving?: boolean;
  children: ReactNode;
}

/** Drawer section with its own Save (LD-140, 10-DESIGN-SYSTEM §4). Save name includes the title so several Saves stay distinct. */
export function DrawerSection({ title, onSave, isSaving = false, children }: DrawerSectionProps) {
  const id = useId();
  return (
    <section className="lims-drawer-section" aria-labelledby={id}>
      <div className="lims-drawer-section-header">
        <h3 id={id} className="lims-drawer-section-title">
          {title}
        </h3>
        <Button size="sm" isDisabled={isSaving} onPress={onSave}>
          {isSaving ? 'Saving…' : 'Save'}
          <VisuallyHidden> {title}</VisuallyHidden>
        </Button>
      </div>
      {children}
    </section>
  );
}
