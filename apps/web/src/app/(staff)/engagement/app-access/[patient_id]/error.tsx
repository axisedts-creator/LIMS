'use client';
// W8 Error boundary: only the opaque digest is shown as a reference, never the message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function AppAccessError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="App access for this patient could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
