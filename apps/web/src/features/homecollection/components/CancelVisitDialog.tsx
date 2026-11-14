'use client';
// §2.1 Cancel dialog (H6): ConfirmDialog tone=danger with the homecollection.visit_cancel_reasons coded set. Shared with the visit page (HC-T19).
import { cancelAction } from '../server/actions';
import type { CodedValue, VisitDto } from '../types';
import { ReasonConfirm } from './ReasonConfirm';

export interface CancelVisitDialogProps {
  visit: Pick<VisitDto, 'id' | 'version' | 'kind' | 'status'>;
  reasons: readonly CodedValue[];
  isOpen: boolean;
  onClose: () => void;
}

export function CancelVisitDialog({ visit, reasons, isOpen, onClose }: CancelVisitDialogProps) {
  return (
    <ReasonConfirm
      isOpen={isOpen} onClose={onClose} title="Cancel this visit?" confirmLabel="Cancel visit" codedSet="homecollection.visit_cancel_reasons" reasons={reasons} doneTitle="Visit cancelled."
      submit={(code, text, key) => cancelAction(visit.id, visit.version, code, text, key)}
      body={
        <>
          <p>The phlebotomist will see it as cancelled after their next sync.</p>
          {visit.kind === 'booking' && visit.status === 'assigned' ? <p>The order and bill in front desk are not cancelled automatically.</p> : null}
        </>
      }
    />
  );
}
