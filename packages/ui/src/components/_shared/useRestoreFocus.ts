import { useLayoutEffect, useRef } from 'react';

/**
 * Return focus to the element that was focused when `isOpen` became true (04 §5.3).
 * react-aria also does this, but in a later animation frame; under load the page sits with focus on <body>
 * in between. We restore in a microtask after the closing commit, once react-aria has removed `inert`
 * from the rest of the page, and only if focus was actually lost.
 */
export function useRestoreFocus(isOpen: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (isOpen && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = isOpen;
  useLayoutEffect(() => {
    if (!isOpen) return;
    return () => {
      const el = opener.current;
      queueMicrotask(() => {
        const a = document.activeElement;
        if (el?.isConnected && el !== document.body && (!a || a === document.body)) el.focus();
      });
    };
  }, [isOpen]);
}
