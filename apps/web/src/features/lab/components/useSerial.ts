'use client';
// LD-194 WEB-BUILD-1: the useRef code split out of shared.tsx so the server page labels/page.tsx can import NO_ACCESS as a real value.
import { useRef } from 'react';

/** Runs scan jobs strictly one after another, so rows / receives follow SCAN order even when lookups answer out of order. */
export function useSerial() {
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  return (job: () => Promise<void>) => {
    tail.current = tail.current.then(job).catch(() => undefined);
  };
}
