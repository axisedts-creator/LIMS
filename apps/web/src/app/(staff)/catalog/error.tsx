'use client';
// Segment-level error boundary for every /catalog/* page (C0 04-UI-UX §7: ErrorState).
// Shows only the opaque digest as a reference — never the raw message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function CatalogError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section aria-label="Catalog">
      <ErrorState
        title="Something went wrong"
        body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
        {...(error.digest ? { requestId: error.digest } : {})}
        onRetry={reset}
      />
    </section>
  );
}
