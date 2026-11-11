'use client';
// Segment-level error boundary for /analytics/* (C8 03-APP-FLOW §5: ErrorState with request id + retry).
// Shows only the opaque digest as a reference — never the raw message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function AnalyticsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
