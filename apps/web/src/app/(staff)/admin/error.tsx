'use client';
// Segment-level error boundary for /admin/*: ErrorState with the opaque digest as reference — never the raw message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
