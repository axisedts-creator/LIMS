'use client';
// One Idempotency-Key per distinct submission: a retry of the SAME body re-sends the same key (the server replays, US-03-5), a changed body is a new
// submission with a new key (reusing a key with a different body would be idempotency_key_reused). The key comes from the platform CSPRNG.
import { useRef } from 'react';

export function useSubmissionKey(): (signature: string) => string {
  const last = useRef<{ sig: string; key: string } | undefined>(undefined);
  return (sig) => {
    if (last.current?.sig !== sig) last.current = { sig, key: globalThis.crypto.randomUUID() };
    return last.current.key;
  };
}
