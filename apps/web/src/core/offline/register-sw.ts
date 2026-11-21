// T0D-OFFLINE-1 (offline design section 6): service worker registration. A new worker waits until the page says so:
// onUpdateReady tells the UI, applyUpdate({ busy }) refuses while the user is mid work, then asks the worker to take
// over and reloads once the new worker controls the page.

interface SWLike { postMessage(m: unknown): void; state?: string; addEventListener?(t: string, h: () => void): void }
interface RegLike { installing: SWLike | null; waiting: SWLike | null; addEventListener(t: string, h: () => void): void }
interface NavLike { serviceWorker?: { register(url: string, o: { scope: string }): Promise<RegLike>; controller: unknown; addEventListener(t: string, h: () => void): void } }

export async function registerServiceWorker(nav: NavLike = globalThis.navigator as unknown as NavLike, o: { onUpdateReady: () => void; url?: string }) {
  const sw = nav?.serviceWorker;
  if (!sw) return { registration: null, applyUpdate: async (_: { busy: () => boolean }) => false };
  const reg = await sw.register(o.url ?? '/sw.js', { scope: '/' });
  let announced: SWLike | null = null;
  const announce = () => { if (reg.waiting && sw.controller && reg.waiting !== announced) { announced = reg.waiting; o.onUpdateReady(); } };
  const track = (w: SWLike | null) => w?.addEventListener?.('statechange', () => { if (w.state === 'installed') announce(); });
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
  announce();
  let wanted = false;
  sw.addEventListener('controllerchange', () => { if (wanted) { wanted = false; globalThis.location?.reload(); } });
  return {
    registration: reg,
    async applyUpdate(a: { busy: () => boolean }): Promise<boolean> {
      if (a.busy() || !reg.waiting) return false;
      wanted = true;
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      return true;
    },
  };
}
