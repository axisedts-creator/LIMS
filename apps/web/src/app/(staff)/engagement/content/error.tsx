'use client';
// T0D-CONTENT-1 error boundary: the page title stays (LD-353 rule 6); only the opaque digest is shown as a reference.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';

export default function PortalContentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="lims-stack">
      <PageHeader title={t('engagement.content.page.title')} helpKey="engagement.content" />
      <ErrorState title={t('engagement.content.fail.other')} {...(error.digest ? { requestId: error.digest } : {})} onRetry={reset} />
    </div>
  );
}
