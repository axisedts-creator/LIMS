'use client';
// S1 header actions (04-UI-UX §2 Refresh; §3 empty-state "Show yesterday"). Refresh goes through a server action -> BFF.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { useToast } from '@lims/ui/components/Toast';
import { shortcuts } from '@/core/shortcuts/registry';
import { refreshAction } from '../server/actions';

const COOLDOWN_MS = 5 * 60_000; // ponytail: 5 min per 04-UI-UX; the API's next_allowed_at wins when present
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kathmandu' });
const endOf = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : Date.now() + COOLDOWN_MS;
};

/** 03-APP-FLOW §2 step 5: re-run the server component every 5 min, only while the tab is visible. */
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, COOLDOWN_MS);
    return () => clearInterval(t);
  }, [router]);
  return null;
}

/** `pageId` = shortcut scope of Alt+R (dashboard by default; report pages pass their own). */
export function RefreshButton({ pageId = 'staff.analytics.dashboard' }: { pageId?: string } = {}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState<string>();
  const inflight = useRef(false);
  const cooling = useRef(false); // Alt+R honours the same disabled state as the button
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const press = async () => {
    if (inflight.current || cooling.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      const r = await refreshAction();
      const end = endOf(r.ok ? r.data.nextAllowedAt : undefined);
      const text = `Refresh available at ${TIME.format(end)}`;
      if (r.ok || r.status === 429) {
        cooling.current = true;
        setUntil(text);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          cooling.current = false;
          setUntil(undefined);
        }, Math.max(0, end - Date.now()));
        if (!r.ok) toast.show({ tone: 'warning', title: text });
      } else {
        toast.show({ tone: 'danger', title: 'Refresh failed. Try again.' });
      }
    } catch {
      toast.show({ tone: 'danger', title: 'Refresh failed. Try again.' });
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const run = useRef(press);
  run.current = press;
  useEffect(() => shortcuts.register(pageId, { key: 'Alt+R', description: 'Refresh', run: () => void run.current() }), [pageId]);

  return (
    <>
      <Button variant="secondary" isLoading={busy} isDisabled={!!until} onPress={press}>
        Refresh
      </Button>
      {until ? <span role="status">{until}</span> : null}
    </>
  );
}

/** `query` = already-whitelisted non-period params (centre/branch), "a=b&c=d" or "". */
export function ShowYesterday({ from, query }: { from: string; query: string }) {
  const router = useRouter();
  const go = () => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const prev = d.toISOString().slice(0, 10);
    router.push(`/analytics?business_date_from=${prev}&business_date_to=${from}${query ? `&${query}` : ''}`);
  };
  return <Button variant="primary" onPress={go}>Show yesterday</Button>;
}
