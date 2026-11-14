'use client';
// C13.T18 segment error boundary (03-APP-FLOW §6). Never prints error.message (may hold internal detail); digest only as a reference.
// LD-140: kit component only.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function SegmentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const ref = typeof error?.digest === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(error.digest) ? error.digest : undefined;
  return <ErrorState title="Something went wrong." body="Try again in a moment." {...(ref ? { requestId: ref } : {})} onRetry={reset} />;
}
