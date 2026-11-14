'use client';
// Opaque digest only, never the raw message or stack.
import { PartnersError } from '@/features/partners/components/common';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PartnersError digest={error.digest} reset={reset} />;
}
