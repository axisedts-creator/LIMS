'use client';
import { QueueScreen, type QueueProps } from './QueueScreen';

/** /lab/approval (04-UI-UX §3.8, §3.6 "Approve"): bulk approve; aal1 → step-up via `onStepUp`, then the same request is re-sent. */
export function ApprovalQueue(p: QueueProps) {
  return <QueueScreen mode="approve" {...p} />;
}
