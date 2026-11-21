'use client';
// Shared body of the lab error.tsx boundaries (02-CV §2.4): the opaque digest is the only reference shown — never the raw message or stack.
import { ErrorState } from '@lims/ui/components/ErrorState';

// T0D-UICONSOLE-1 (LD-353 rule 6): pageTitle keeps the page's menu title (h1) above the state.
export function LabError({ digest, reset, pageTitle }: { digest?: string | undefined; reset: () => void; pageTitle?: string }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(digest ? { requestId: digest } : {})}
      onRetry={reset}
      {...(pageTitle ? { pageTitle } : {})}
    />
  );
}
