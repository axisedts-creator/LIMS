'use client';
// Error boundary: only the opaque digest is shown as a reference, never the message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function QcRunsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState title="We couldn't load QC runs." body="Try again; if it keeps failing, contact support with the reference." {...(error.digest ? { requestId: error.digest } : {})} onRetry={reset} />;
}
