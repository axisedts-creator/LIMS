'use client';
// T0D-OFFLINE-2 (LD-322 decision 4, LD-353): the offline parts of the staff shell. Each renders nothing without an OfflineProvider.
//   OfflineStatusChip  top bar link to /offline: Online, Offline with N pending, Syncing, Needs attention N, Ready for offline (age)
//   OfflineNotices     banner while offline or degraded; clock skew warning
//   UnlockOverlay      PIN entry inside the shell (not a route under app/(auth)); PIN set up after an online sign in
//   useSignOutGuard    signing out with unsynced operations: they stay encrypted on this device; the user is told first
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { t } from '../../i18n/messages';
import { chipState, tf } from '../chip';
import type { UnlockResult } from '../store';
import { isOnline, useOfflineController, useOfflineSnapshot } from './OfflineProvider';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/** Modal dialog: focus moves in and stays in; Escape calls onClose when one is given. */
export function Modal({ title, role = 'dialog', onClose, wide, children }: { title: string; role?: 'dialog' | 'alertdialog'; onClose?: (() => void) | undefined; wide?: boolean; children: ReactNode }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return; }
    if (e.key !== 'Tab') return;
    const list = Array.from(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === list.length - 1 ? 0 : i + 1);
    e.preventDefault();
    list[next]!.focus();
  };
  return (
    <div className="lims-overlay">
      <div ref={box} role={role} aria-modal="true" aria-labelledby={id} className={`lims-dialog lims-surface ${wide ? 'lims-dialog-lg' : 'lims-dialog-sm'}`} onKeyDown={onKey}>
        <div className="lims-dialog-body">
          <h2 id={id} className="lims-dialog-title">{title}</h2>
          {children}
        </div>
      </div>
    </div>
  );
}

export function OfflineStatusChip() {
  const s = useOfflineSnapshot();
  if (!s) return null;
  const c = chipState({ conn: s.conn, pending: s.pending.length, attention: s.attention.length, conflicts: s.conflicts.length, prefetch: s.prefetch, now: s.now });
  return <a href="/offline" className="lims-chip lims-offline-chip" data-testid="offline-chip" data-state={c.kind}>{c.label}</a>;
}

export function OfflineNotices() {
  const s = useOfflineSnapshot();
  if (!s) return null;
  return (
    <>
      {s.conn === 'offline' || s.conn === 'degraded' ? <div role="status" className="lims-banner lims-offline-banner">{t('offline.banner')}</div> : null}
      {s.skewFlag ? <div role="status" className="lims-banner lims-offline-banner">{t('offline.skew')}</div> : null}
    </>
  );
}

const field = (label: string, input: ReactNode, id: string) => (
  <div className="lims-field"><label htmlFor={id}>{label}</label>{input}</div>
);
const finalText = (r: string) => t(`offline.unlock.${r === 'expired' || r === 'wiped' || r === 'revoked' ? r : 'failed'}`);
export const attemptsText = (n: number) => (n === 1 ? t('offline.unlock.attempt') : tf('offline.unlock.attempts', { n }));

function UnlockDialog({ online, onHide }: { online: boolean; onHide: () => void }) {
  const c = useOfflineController()!;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [pin, setPin] = useState('');
  const [running, setRunning] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [final, setFinal] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy.current || !pin) return;
    busy.current = true; setRunning(true);
    let r: UnlockResult | null = null;
    try { r = await c.unlock(pin); } catch { r = null; }
    busy.current = false; setRunning(false);
    if (r?.ok) return;
    setPin('');
    if (r && r.reason === 'wrong_pin') { setLeft(r.attemptsLeft); input.current?.focus(); } else setFinal(r ? r.reason : 'failed');
  };
  return (
    <Modal title={t('offline.unlock.title')} onClose={online ? onHide : undefined}>
      {final ? (
        <>
          <p role="alert">{finalText(final)}</p>
          <div className="lims-dialog-footer"><button type="button" className="lims-btn" onClick={onHide}>{t('offline.unlock.close')}</button></div>
        </>
      ) : (
        <form onSubmit={submit} className="lims-form">
          <p>{t('offline.unlock.hint')}</p>
          {field(t('offline.unlock.pin'), <input ref={input} id={id} data-autofocus type="password" inputMode="numeric" autoComplete="off" className="lims-input" value={pin} onChange={(e) => setPin(e.target.value)} />, id)}
          {left !== null ? <p role="alert">{attemptsText(left)}</p> : null}
          <div className="lims-dialog-footer">
            {online ? <button type="button" className="lims-btn" onClick={onHide}>{t('offline.unlock.not_now')}</button> : null}
            <button type="submit" className="lims-btn lims-btn-primary" disabled={running}>{t('offline.unlock.submit')}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function SetupDialog({ onHide }: { onHide: () => void }) {
  const c = useOfflineController()!;
  const a = useId(); const b = useId();
  const [pin, setPin] = useState(''); const [again, setAgain] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (running) return;
    if (!pin) { setErr(t('offline.setup.required')); return; }
    if (pin !== again) { setErr(t('offline.setup.mismatch')); return; }
    setRunning(true); setErr(null);
    try { if (!(await c.setupPin(pin)).ok) setErr(t('offline.unlock.failed')); } catch { setErr(t('offline.unlock.failed')); }
    setRunning(false);
  };
  return (
    <Modal title={t('offline.setup.title')} onClose={onHide}>
      <form onSubmit={submit} className="lims-form">
        <p>{t('offline.setup.hint')}</p>
        {field(t('offline.setup.new'), <input id={a} data-autofocus type="password" inputMode="numeric" autoComplete="new-password" className="lims-input" value={pin} onChange={(e) => setPin(e.target.value)} />, a)}
        {field(t('offline.setup.confirm'), <input id={b} type="password" inputMode="numeric" autoComplete="new-password" className="lims-input" value={again} onChange={(e) => setAgain(e.target.value)} />, b)}
        {err ? <p role="alert">{err}</p> : null}
        <div className="lims-dialog-footer">
          <button type="button" className="lims-btn" onClick={onHide}>{t('offline.setup.skip')}</button>
          <button type="submit" className="lims-btn lims-btn-primary" disabled={running}>{t('offline.setup.submit')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function UnlockOverlay() {
  const s = useOfflineSnapshot();
  const [hidden, setHidden] = useState(false); // "Not now" / "Skip for now": for this page view
  if (!s || hidden) return null;
  const online = isOnline(s);
  const hide = () => setHidden(true);
  if (s.storeState === 'locked') return <UnlockDialog online={online} onHide={hide} />;
  if ((s.storeState === 'empty' || s.storeState === 'wiped') && online) return <SetupDialog onHide={hide} />;
  if (s.storeState === 'wiped' || s.storeState === 'revoked') {
    return (
      <Modal title={t('offline.unlock.title')} onClose={hide}>
        <p>{finalText(s.storeState)}</p>
        <div className="lims-dialog-footer"><button type="button" className="lims-btn" onClick={hide}>{t('offline.unlock.close')}</button></div>
      </Modal>
    );
  }
  return null;
}

/** done_when 6: the Sign out menu item asks first while operations are not synced (they are kept, encrypted, never dropped). */
export function useSignOutGuard(signOutPath: string) {
  const s = useOfflineSnapshot();
  const [open, setOpen] = useState(false);
  const n = s ? s.pending.length + s.attention.length + s.conflicts.length : 0;
  const onSignOut = s ? (e: MouseEvent) => { if (n > 0) { e.preventDefault(); setOpen(true); } } : undefined;
  const close = () => setOpen(false);
  const dialog = open && s ? (
    <Modal title={t('offline.signout.title')} role="alertdialog" onClose={close}>
      <p>{tf('offline.signout.body', { n })}</p>
      {s.signedInUsers <= 1 ? <p>{t('offline.signout.last')}</p> : null}
      <div className="lims-dialog-footer">
        <a href={signOutPath} className="lims-btn">{t('offline.signout.anyway')}</a>
        <button type="button" className="lims-btn lims-btn-primary" data-autofocus onClick={close}>{t('offline.signout.stay')}</button>
      </div>
    </Modal>
  ) : null;
  return { onSignOut, dialog };
}
