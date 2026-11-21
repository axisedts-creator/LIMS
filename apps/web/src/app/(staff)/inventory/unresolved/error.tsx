'use client';
// Error boundary for /inventory/unresolved (C0 04-UI-UX §7: ErrorState). Shows only the opaque digest as a reference, never the raw message.
// T0D-UICONSOLE-1 (LD-353 rule 6): the page keeps its menu title.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { t } from '@/core/i18n/messages';

export default function UnresolvedError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
      pageTitle={t('inventory.nav.unresolved')}
    />
  );
}
