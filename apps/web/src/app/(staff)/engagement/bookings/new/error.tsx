'use client';
// W3 Error boundary: only the opaque digest is shown as a reference, never the message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function BookingNewError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="The new-booking form could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
