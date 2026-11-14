'use client';
// Bits shared by the T-22 batch screens: status chip (tone + icon + word), batch problem-code copy (04-UI-UX §8), the step-up dialog.
// LD-140 (2026-11-13, binding): kit components and token class names only.
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import type { BatchStatus } from '../../server/types';
import { Chip, failText, isConflict, type Fail, type Tone } from '../common';

export const BATCH_STATUS: Record<BatchStatus, readonly [Tone, string]> = { open: ['info', 'Open'], closed: ['neutral', 'Closed'] };

export function BatchStatusChip({ status, size }: { status: BatchStatus; size?: 'sm' | 'md' }) {
  const [tone, label] = BATCH_STATUS[status] ?? (['neutral', String(status)] as const);
  return <Chip tone={tone} label={label} {...(size ? { size } : {})} />;
}

/** Copy for a failed batch call. `position` is the position the user tried to fill; codes not listed fall back to the shared copy (never the raw code). */
export function batchFail(f: Fail, position?: number): { tone: Tone; text: string; reload: boolean } {
  if (f.code === 'anatomic.batch_closed') return { tone: 'warning', text: 'This batch is closed.', reload: true };
  if (f.code === 'anatomic.batch_position_taken') return { tone: 'warning', text: position ? `Position ${position} is already used.` : 'That position is already used.', reload: true };
  if (isConflict(f)) return { tone: 'warning', text: 'This batch was changed by someone else. Reload to see the latest version.', reload: true };
  return { tone: 'danger', text: failText(f), reload: false };
}

export function MfaDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <Dialog
      title="Two-factor verification"
      size="sm"
      isOpen={isOpen}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          {/* ponytail: no C2 step-up route is known (same as CaseWorkspace); reload lets the session guard redirect to it, then the user repeats the action. */}
          <Button variant="primary" onPress={() => window.location.reload()}>Verify now</Button>
        </>
      }
    >
      <p>This action needs two-factor verification.</p>
    </Dialog>
  );
}
