'use client';
// 02-CV §2.4: every page has error.tsx. Shows only the opaque digest as a reference — never the raw message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function NewRegistrationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="The registration page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
    />
  );
}
