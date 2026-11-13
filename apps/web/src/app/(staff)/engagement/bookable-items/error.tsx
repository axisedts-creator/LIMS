'use client';
// W5 Error boundary: only the opaque digest is shown as a reference, never the message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function BookableError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="The bookable catalogue could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
