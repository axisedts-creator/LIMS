'use client';
// 02-CV §2.4 error boundary: opaque digest only, never the raw message or stack.
// T0D-UIGUARD-1-FRONTDESK (LD-353 rule 4): a failed read (5xx propagates here, see page.tsx) draws the kit ErrorState with reference + Retry.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This order could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
