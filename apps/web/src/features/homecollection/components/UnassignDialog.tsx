'use client';
// §2.1 Unassign dialog (H4): ConfirmDialog with the homecollection.unassign_reasons coded set.
import { unassignAction } from '../server/actions';
import type { CodedValue, VisitDto } from '../types';
import { ReasonConfirm } from './ReasonConfirm';

export interface UnassignDialogProps {
  visit: Pick<VisitDto, 'id' | 'version'>;
  reasons: readonly CodedValue[];
  isOpen: boolean;
  onClose: () => void;
}

export function UnassignDialog({ visit, reasons, isOpen, onClose }: UnassignDialogProps) {
  return (
    <ReasonConfirm
      isOpen={isOpen} onClose={onClose} tone="default" title="Unassign this visit?" confirmLabel="Confirm" codedSet="homecollection.unassign_reasons" reasons={reasons} doneTitle="Visit taken off the route."
      submit={(code, text, key) => unassignAction(visit.id, visit.version, code, text, key)}
      body={<p>The phlebotomist will no longer see this visit after their next sync.</p>}
    />
  );
}
