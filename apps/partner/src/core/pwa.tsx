'use client';
// C13.T20 PWA client glue (02-TRD §3.7, US-16.2, ST14): register the static-only service worker; purge browser-side state on logout.
import { useEffect } from 'react';

/** Must match STATIC_CACHE in public/sw.js: the only cache that may survive logout (static assets + /offline, no PHI). */
const STATIC_CACHE = 'partner-static-v1';

/** Delete every cache except the static one and clear sessionStorage. localStorage holds only lims.partner.density (non-PHI). */
export async function purgeBrowserState(): Promise<void> {
  try {
    sessionStorage.clear();
  } catch {
    /* storage blocked: nothing to clear */
  }
  if (typeof caches === 'undefined') return;
  try {
    for (const name of await caches.keys()) {
      if (name !== STATIC_CACHE) await caches.delete(name);
    }
  } catch {
    /* cache API unavailable: nothing to purge */
  }
}

/** Mounted once in the root layout. Registration failure is silent: the portal works without the worker. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}

/**
 * Purges on mount (the sign-in page: reached after logout, session expiry and fresh visits) or, with on="submit",
 * when the enclosing page's sign-out form is submitted (capture phase, before the server action navigates away).
 */
export function PurgeBrowserState({ on = 'mount' }: { on?: 'mount' | 'submit' }) {
  useEffect(() => {
    if (on === 'mount') {
      void purgeBrowserState();
      return;
    }
    const h = () => void purgeBrowserState();
    document.addEventListener('submit', h, true);
    return () => document.removeEventListener('submit', h, true);
  }, [on]);
  return null;
}
