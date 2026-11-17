'use client';
// Segment-level error boundary for every /catalog/* page (C0 04-UI-UX §7: ErrorState).
// Shows only the opaque digest as a reference — never the raw message or stack.
// T0D-CATUNITS-1 (LD-310): the body names the list that failed, from the first path segment after /catalog
// ("units could not be loaded"); /catalog itself and unknown segments keep the generic sentence. Ids are never echoed.
import { usePathname } from 'next/navigation';
import { ErrorState } from '@lims/ui/components/ErrorState';

const WHAT: Record<string, string> = {
  units: 'Units', tests: 'Tests', panels: 'Panels', departments: 'Departments', specimens: 'Specimens', methods: 'Methods',
  doctors: 'Doctors', 'price-lists': 'Price lists', 'comment-codes': 'Comment codes', 'credit-parties': 'Credit parties',
  surcharges: 'Surcharges', tax: 'Tax rules', imports: 'Imports',
}; // [CONV] plain names of the catalog lists

export default function CatalogError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const what = WHAT[(usePathname() ?? '').split('/')[2] ?? ''];
  return (
    <section aria-label="Catalog">
      <ErrorState
        title="Something went wrong"
        body={`${what ? `${what} could not be loaded.` : 'This page could not be loaded.'} Try again; if it keeps failing, contact support with the reference.`}
        {...(error.digest ? { requestId: error.digest } : {})}
        onRetry={reset}
      />
    </section>
  );
}
