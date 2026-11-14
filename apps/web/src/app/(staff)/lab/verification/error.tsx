'use client';
// 02-CV §2.4 error boundary: opaque digest only, never the raw message or stack.
import { LabError } from '@/features/lab/components/LabError';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <LabError digest={error.digest} reset={reset} />;
}
