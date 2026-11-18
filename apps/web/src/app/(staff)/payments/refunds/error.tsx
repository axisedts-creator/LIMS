'use client';
// Error boundary for /payments/refunds: only the opaque digest is shown as a reference, never the message or stack.
// T0D-UICONSOLE-1 (LD-353 rule 6): the page keeps its menu title.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { t } from '@/core/i18n/messages';

export default function GatewayRefundsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(error.digest ? { requestId: error.digest } : {})}
      onRetry={reset}
      pageTitle={t('payments.nav.refunds')}
    />
  );
}
