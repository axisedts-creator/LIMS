'use client';
// F8 quote refresh: 300 ms [CONV] after any change to the draft; Register stays disabled until the LATEST quote returned (04-UI-UX §3.1).
import { useCallback, useEffect, useRef, useState } from 'react';
import { quoteRegistrationAction } from '../server/actions';
import type { Quote, RegistrationDraft } from '../server/types';

export const QUOTE_DEBOUNCE_MS = 300;
export type QuoteState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ready'; quote: Quote }
  | { status: 'error'; code: string; title?: string };

export function useQuote(draft: RegistrationDraft | null): { state: QuoteState; refresh: () => void } {
  const [state, setState] = useState<QuoteState>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const key = draft ? JSON.stringify(draft) : '';
  const latest = useRef(draft);
  latest.current = draft;

  useEffect(() => {
    const my = ++seq.current; // any older response is stale from here on
    if (!key || !latest.current) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'pending' });
    const t = setTimeout(() => {
      void quoteRegistrationAction(latest.current as RegistrationDraft).then((r) => {
        if (my !== seq.current) return;
        setState(r.ok ? { status: 'ready', quote: r.data } : { status: 'error', code: r.code, ...(r.title ? { title: r.title } : {}) });
      });
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { state, refresh };
}
