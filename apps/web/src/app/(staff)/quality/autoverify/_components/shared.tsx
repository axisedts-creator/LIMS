'use client';
// C9 T-23 shared view pieces. LD-140: composed only from @lims/ui components; no colours, sizes or inline styles here.
// Every write on these screens answers 403 auth.mfa_required (aal2, REQ-SEC-062) with a "Verify now" banner, keeps the input, and a second press re-sends the SAME request.
import { useId, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useAttemptKey } from '@/features/quality/components/Shared';
import { NOT_SWITCHED_ON, NO_ACCESS } from '../_lib/format';
import type { ActionResult, FieldError } from '../_lib/types';

export type Op = 'create' | 'save' | 'start' | 'stop' | 'discard' | 'activate' | 'retire' | 'read';
export interface Notice { tone: 'warning' | 'danger'; title: string; action?: 'verify' | 'reload'; errors?: FieldError[] }

const TRANSITION: Record<Op, string> = {
  create: 'This version could not be created from the one you chose. Reload and try again.',
  save: 'This version can no longer be edited.',
  start: "This version can't be started: another version is already simulating, or its status changed.",
  stop: 'This simulation was already stopped, or its status changed.',
  discard: "This version's status changed, so it can't be discarded now.",
  activate: "This version's status changed and it can't be activated now. Reload to see its current status.",
  retire: "This version's status changed, so it can't be retired now.",
  read: 'The action did not complete. Try again.',
};
/** Plain-language text for the API errors these actions can return (never the raw code). */
export function noticeOf(r: { status: number; code: string; errors?: FieldError[] | undefined }, op: Op): Notice {
  switch (r.code) {
    case 'auth.mfa_required':
      return { tone: 'warning', action: 'verify', title: 'Confirm your identity before you continue. Verify now, then try again. Nothing was saved.' };
    case 'quality.rule_set_invalid':
      return { tone: 'danger', title: "This rule set isn't valid. Fix the marked rules and try again.", ...(r.errors ? { errors: r.errors } : {}) };
    case 'quality.rule_set_invalid_transition':
      return { tone: 'danger', action: 'reload', title: TRANSITION[op] };
    case 'common.version_conflict':
    case 'common.precondition_required':
      return { tone: 'warning', action: 'reload', title: 'Someone else saved this version first. Your input is still here.' };
    case 'quality.self_activation_forbidden':
      return { tone: 'danger', title: "You can't activate a version you created. Ask another person to activate it." };
    case 'quality.simulation_incomplete':
      return { tone: 'danger', title: "The simulation has not reached the minimum days and decisions yet. Let it run longer, then activate." };
    case 'common.validation_failed':
      return { tone: 'danger', title: 'Check the values and try again.' };
    case 'auth.forbidden':
      return { tone: 'danger', title: 'You no longer have access to this action.' };
    case 'common.not_found':
      return { tone: 'danger', title: "This version doesn't exist or isn't in your lab." };
    default:
      return { tone: 'danger', title: 'The action did not complete. Try again.' };
  }
}

export function NoticeBanner({ notice, onReload }: { notice: Notice | undefined; onReload?: () => void }) {
  if (!notice) return null;
  const action = notice.action === 'verify'
    ? { label: 'Verify now', onPress: () => window.location.reload() } // ponytail: no C2 step-up route is known; the reload lets the session guard redirect to it, then the user repeats the action.
    : notice.action === 'reload' && onReload ? { label: 'Reload', onPress: onReload } : undefined;
  return (
    <div role="alert">
      <Banner tone={notice.tone} title={notice.title} {...(action ? { action } : {})} />
    </div>
  );
}

/** One write at a time (a double click sends ONE request); one Idempotency-Key per distinct request body (a step-up retry re-sends the key). */
export function useWrite() {
  const key = useAttemptKey();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const run = async <T,>(op: Op, signature: string, call: (key: string) => Promise<ActionResult<T>>, onOk: (data: T) => void) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setNotice(undefined);
    try {
      const r = await call(key.keyFor(signature));
      if (r.ok) {
        key.done();
        onOk(r.data);
      } else setNotice(noticeOf(r, op));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const reset = () => { key.done(); setNotice(undefined); };
  return { run, pending, notice, reset };
}

/** Honest page states that replace the whole screen: no permission (no API call was made), module switched off, or a missing version. */
export function PageNotice({ kind, title, helpKey, message }: { kind: 'denied' | 'disabled' | 'missing'; title: string; helpKey: string; message?: string }) {
  return (
    <>
      <PageHeader title={title} helpKey={helpKey} />
      <EmptyState
        title={kind === 'missing' ? (message ?? 'Not found') : kind === 'denied' ? NO_ACCESS : NOT_SWITCHED_ON}
        {...(kind === 'denied' ? { body: 'Ask your lab administrator for auto-verification access.' } : {})}
      />
    </>
  );
}

/** Native <select> with a label (same reason as lab/NativeSelect: the list sits inside the dialog / page, and the platform control is the accessible one). */
export function NativeSelect({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; placeholder?: string }) {
  const id = useId();
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}</label>
      <select id={id} className="lims-input" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
