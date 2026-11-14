'use client';
// Shared bits for the SCR-06…08 components: permission names, error → Banner mapping, date format.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, type BannerProps } from '@lims/ui/components/Banner';
import { Button, type ButtonProps } from '@lims/ui/components/Button';
import { Tooltip } from '@lims/ui/components/Tooltip';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import type { ActionResult } from '../server/types';
import './catalog.css';

export type Tone = BannerProps['tone'];

export const PERM = { read: 'catalog.test.read', manage: 'catalog.test.manage', publish: 'catalog.reference_range.publish' } as const;
export type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export const RELOAD_TEXT = 'Someone else changed this item. Reload to see their changes.';
export const MFA_TEXT = 'Confirm with your authenticator to continue';
export const newKey = () => crypto.randomUUID();

/** Server message for the first error whose JSON-pointer path is one of `paths`. */
export const errAt = (f: Fail | undefined, ...paths: string[]) => f?.errors?.find((e) => e.path !== undefined && paths.includes(e.path))?.message;

const TENANT_TZ = 'Asia/Kathmandu'; // [CONV] tenant default timezone (CV §4.8)
/** DD/MM/YYYY HH:mm in the tenant timezone, 24-hour. */
export function fmtDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TENANT_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`;
}

const MESSAGES: Record<string, { tone: Tone; title: string }> = {
  'common.version_conflict': { tone: 'warning', title: RELOAD_TEXT },
  'catalog.version_in_use': { tone: 'warning', title: 'This version is already published or in use and can no longer be changed.' },
  'auth.mfa_required': { tone: 'info', title: MFA_TEXT },
  'auth.forbidden': { tone: 'danger', title: 'You do not have permission to do this.' },
  'catalog.formula_invalid': { tone: 'danger', title: 'The formula is not valid.' },
  'common.precondition_required': { tone: 'warning', title: 'Reload the page and try again.' },
  'common.validation_failed': { tone: 'danger', title: 'Check the highlighted fields and try again.' },
};

/** role="alert" wrapper (the kit Banner has no live-region role); `extra` sits beside it, e.g. a "Create new version" button. */
export function FailBanner({ fail, extra }: { fail: Fail; extra?: ReactNode }) {
  const router = useRouter();
  const m = MESSAGES[fail.code] ?? { tone: 'danger' as const, title: 'Something went wrong. Try again.' };
  return (
    <div className="lims-stack catalog-gap-2">
      <div role="alert">
        <Banner tone={m.tone} title={m.title} {...(fail.code === 'common.version_conflict' ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} />
      </div>
      {extra}
    </div>
  );
}

/**
 * [CONV] The kit Select marks its root `data-invalid` but never sets aria-invalid on the trigger button, so assistive tech and
 * tests cannot see the error state. Mirror it here until packages/ui Select does (CR for the kit owner).
 */
export function MirrorInvalid({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const sync = () =>
      root.querySelectorAll<HTMLElement>('button[aria-haspopup]').forEach((b) => {
        if (b.closest('[data-invalid]')) b.setAttribute('aria-invalid', 'true');
        else b.removeAttribute('aria-invalid');
      });
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-invalid'] });
    return () => mo.disconnect();
  }, []);
  return <div ref={ref} className="catalog-contents">{children}</div>;
}

/**
 * Button that is disabled with the missing permission named (AC-03.6 / AC-05.9). A disabled button gets no hover/focus, so the
 * reason is also linked via aria-describedby (Button has no such prop) — same approach as instruments/AgentActions.
 */
export function GatedButton({ missing, children, ...props }: ButtonProps & { missing: readonly string[] }) {
  const hintId = useId();
  if (missing.length === 0) return <Button {...props}>{children}</Button>;
  const text = `Requires permission ${missing.join(' and ')}`;
  return (
    <>
      <Tooltip content={text}>
        <Button {...props} isDisabled ref={(el) => el?.setAttribute('aria-describedby', hintId)}>{children}</Button>
      </Tooltip>
      <VisuallyHidden id={hintId}>{text}</VisuallyHidden>
    </>
  );
}

export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', published: 'Published', superseded: 'Superseded', retired: 'Retired', discarded: 'Discarded' };
export const STATUS_TONE: Record<string, Tone> = { draft: 'info', published: 'success', superseded: 'neutral', retired: 'neutral', discarded: 'neutral' };
