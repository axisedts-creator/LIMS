'use client';
// T0D-UILIST-3, LD-353 rule 6: a failed load keeps the page title and shows message, reference and Retry inside the page (never error.tsx).
// No raw problem text: only the request id the server passes (an id, never the problem detail).
import { useRouter } from 'next/navigation';
import { ErrorState } from '@lims/ui/components/ErrorState';

export function PageError({ title, requestId }: { title: string; requestId?: string | undefined }) {
  const router = useRouter();
  return <ErrorState pageTitle={title} title="This page could not be loaded." body="Try again in a moment." {...(requestId ? { requestId } : {})} onRetry={() => router.refresh()} />;
}
