'use client';
// Segment-level error boundary for every /reporting/* page (04-UI-UX §1: ErrorState).
// Shows only the opaque digest as a reference — never the raw message or stack (PHI / internal detail).
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function ReportingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
