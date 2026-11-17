'use client';
// 02-CV §2.4 error boundary: opaque digest only, never the raw message or stack.
import { FrontdeskError } from '@/features/frontdesk/components/FrontdeskError';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FrontdeskError digest={error.digest} reset={reset} />;
}
