'use client';
// 02-CV §2.4 error boundary: opaque digest only, never the raw message or stack. T0D-UICONSOLE-1 (LD-353 rule 6): the page keeps its menu title.
import { t } from '@/core/i18n/messages';
import { LabError } from '@/features/lab/components/LabError';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <LabError digest={error.digest} reset={reset} pageTitle={t('lab.nav.critical_values')} />;
}
