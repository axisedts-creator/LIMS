'use client';
// 02-CV §2.4 error boundary: opaque digest only, never the raw message or stack. T0D-UICONSOLE-2 (LD-353 rule 6): the menu title stays above the state.
import { t } from '@/core/i18n/messages';
import { LabError } from '@/features/lab/components/LabError';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <LabError digest={error.digest} reset={reset} pageTitle={t('lab.nav.verification')} />;
}
