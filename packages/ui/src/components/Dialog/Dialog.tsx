import type { ReactNode } from 'react';
import { useRestoreFocus } from '../_shared/useRestoreFocus';
import { Dialog as RacDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { IconButton } from '../IconButton/IconButton';
import { msg } from '../_shared/messages';

export interface DialogProps {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer?: ReactNode;
  /** Default true; false for blocking confirmations (no Esc, no outside click, no close button). */
  isDismissable?: boolean;
  'data-testid'?: string;
}

/** Shared modal frame for Dialog and Drawer: focus trap, Esc, focus return (react-aria). */
export function OverlayFrame({
  kind,
  title,
  isOpen,
  onClose,
  className,
  children,
  footer,
  isDismissable = true,
  testId,
}: {
  kind: 'dialog' | 'drawer';
  title: string;
  isOpen: boolean;
  onClose: () => void;
  className: string;
  children: ReactNode;
  footer?: ReactNode;
  isDismissable?: boolean;
  testId?: string | undefined;
}) {
  useRestoreFocus(isOpen);
  return (
    <ModalOverlay
      className={`lims-overlay lims-overlay-${kind}`}
      isOpen={isOpen}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal className={className}>
        <RacDialog className="lims-dialog-body" {...(testId ? { 'data-testid': testId } : {})}>
          <div className="lims-dialog-header">
            <Heading slot="title" className="lims-dialog-title">
              {title}
            </Heading>
            {isDismissable ? <IconButton label={msg.close} icon="close" onPress={onClose} /> : null}
          </div>
          <div className="lims-dialog-content">{children}</div>
          {footer ? <div className="lims-dialog-footer">{footer}</div> : null}
        </RacDialog>
      </Modal>
    </ModalOverlay>
  );
}

export function Dialog({ size = 'md', 'data-testid': testId, ...rest }: DialogProps) {
  return <OverlayFrame kind="dialog" className={`lims-dialog lims-dialog-${size}`} testId={testId} {...rest} />;
}
