'use client';
// T0D-UILIST-1 (LD-353 rule 6): a failed page read keeps the page title and shows ErrorState with message, reference and Retry (one re-read), never error.tsx.
import { useRouter } from 'next/navigation';
import { ErrorState } from '@lims/ui/components/ErrorState';

export function LoadError({ title, requestId }: { title: string; requestId?: string }) {
  const router = useRouter();
  return <ErrorState pageTitle={title} title="This page could not be loaded." body="Try again. If it keeps happening, tell your administrator." {...(requestId ? { requestId } : {})} onRetry={() => router.refresh()} />;
}
