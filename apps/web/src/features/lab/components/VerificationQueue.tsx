'use client';
import { QueueScreen, type QueueProps } from './QueueScreen';

/** /lab/verification (04-UI-UX §3.8): bulk verify with per-flag acknowledgement. */
export function VerificationQueue(p: Pick<QueueProps, 'items' | 'permissions'>) {
  return <QueueScreen mode="verify" {...p} />;
}
