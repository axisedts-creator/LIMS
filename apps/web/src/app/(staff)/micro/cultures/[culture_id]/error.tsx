'use client';
// LD-140 (2026-11-13): kit ErrorState + Retry. The raw error text and stack are never shown (they may carry internals); only the digest is a reference.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function CultureError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState title="The culture could not be loaded." body="Try again. If it keeps happening, tell your administrator." {...(error.digest ? { requestId: error.digest } : {})} onRetry={reset} />;
}
