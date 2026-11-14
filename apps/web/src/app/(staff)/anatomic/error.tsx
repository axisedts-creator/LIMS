'use client';
// 04-UI-UX §4.1 errors: "We couldn't load cases." + reference + Retry. The opaque digest is the only reference shown — never the raw message
// or stack (02-CV §2.4). LD-140 (2026-11-13): kit component only.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function AnatomicError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState title="We couldn't load cases." {...(error.digest ? { requestId: error.digest } : {})} onRetry={reset} />;
}
