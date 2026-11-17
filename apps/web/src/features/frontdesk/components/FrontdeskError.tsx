'use client';
// Shared body of the four front-desk error.tsx boundaries (02-CV §2.4). Shows only the opaque digest as a reference — never the raw message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export function FrontdeskError({ digest, reset }: { digest?: string | undefined; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(digest ? { requestId: digest } : {})}
      onRetry={reset}
    />
  );
}
