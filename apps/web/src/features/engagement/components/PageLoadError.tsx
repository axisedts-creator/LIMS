'use client';
// T0D-UILIST-3 (LD-353 rule 6): a failed read keeps the page title and shows the kit ErrorState (message, reference, Retry) inside the page.
import { useRouter } from 'next/navigation';
import { ErrorState } from '@lims/ui/components/ErrorState';

export function PageLoadError({ title, requestId }: { title: string; requestId?: string | undefined }) {
  const router = useRouter();
  return <ErrorState pageTitle={title} title="This page could not be loaded." body="Try again in a moment." {...(requestId ? { requestId } : {})} onRetry={() => router.refresh()} />;
}
