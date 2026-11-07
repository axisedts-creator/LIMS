'use client';
// Opens 2 min before idle expiry; "Stay signed in" keeps the session alive (touch:true via the server action),
// "Sign out" leaves. At expiry the page reloads and middleware serves the sign-in prompt (AC-0D-7.2).
// Deadlines arrive as durations from the server so client clock skew does not matter.
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { t } from '../i18n/messages';
import { keepAlive } from '../session/actions';
import { WARNING_BEFORE_MS } from '../session/policy';

const SIGN_OUT_URL = '/auth/'; // C2 owns sign-out under /auth/… (01-CHUNK-MAP §3)

export function SessionTimeoutDialog({ idleMs, absoluteMs }: { idleMs: number; absoluteMs: number }) {
  const [deadline, setDeadline] = useState(() => ({ idle: Date.now() + idleMs, abs: Date.now() + absoluteMs, stayed: false }));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const now = Date.now();
    const warnIn = deadline.idle - WARNING_BEFORE_MS - now;
    // after "Stay signed in" do not re-open at once if the server-side deadline did not move past the window
    const warn = deadline.stayed && warnIn <= 0 ? undefined : setTimeout(() => setOpen(true), Math.max(0, warnIn));
    const end = setTimeout(() => window.location.reload(), Math.max(1000, Math.min(deadline.idle, deadline.abs) - now));
    return () => { clearTimeout(warn); clearTimeout(end); };
  }, [deadline]);

  const stay = async () => {
    setBusy(true);
    try {
      const r = await keepAlive();
      if (!r) return window.location.reload();
      setOpen(false);
      setDeadline({ idle: Date.now() + r.idleMs, abs: Date.now() + r.absoluteMs, stayed: true });
    } catch {
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('core.session.expiring_title')}
      isOpen={open}
      onClose={() => void stay()}
      isDismissable={false}
      size="sm"
      data-testid="session-timeout-dialog"
      footer={
        <>
          <Button onPress={() => window.location.assign(SIGN_OUT_URL)}>{t('core.session.sign_out')}</Button>
          <Button variant="primary" isLoading={busy} onPress={() => void stay()}>{t('core.session.stay')}</Button>
        </>
      }
    >
      <p>{t('core.session.expiring')}</p>
    </Dialog>
  );
}
