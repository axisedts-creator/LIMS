'use client';
// Error boundary for every /platform route. Shows only the digest (no stack, no server message).
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function PlatformError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState title="Something went wrong" body="The page could not be loaded." {...(error.digest ? { requestId: error.digest } : {})} onRetry={reset} />;
}
