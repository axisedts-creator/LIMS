'use client';
// C9 T-22 shared form pieces for the four set-up tabs. LD-140: composed only from @lims/ui components; no colours, sizes or inline styles here.
// Pickers read C7 / C3 through server actions (BFF); without the read permission, or when the read fails, they become plain id fields (the form stays usable).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { useAttemptKey } from '../components/Shared';
import { analytesOfTestAction, searchInstrumentsAction, searchTestsAction } from './actions';
import type { AnalyteOption, Material, Picked, SetupResult } from './types';
import { MSG, type Errors } from './validate';

export const err = (e: string | undefined) => (e ? { error: e } : {});
const desc = (d: string | undefined) => (d ? { description: d } : {});

// ---------------------------------------------------------------- error text (plain language, never the raw code)
const TEXT = {
  forbidden: "You don't have permission to do this.",
  conflict: 'This record was changed by someone else. Reload the page and try again.',
  immutable: 'This record can no longer be changed. The list has been refreshed.',
  notFound: 'This record no longer exists. Reload the page.',
  unavailable: 'A connected service is not available right now. Try again in a moment.',
  invalid: 'Check the values and try again.',
  generic: 'The action did not complete. Try again.',
  targetMissing: 'Add an active target for every level in the plan first.',
  insufficient: 'Not enough accepted QC values in this period to establish a target.',
} as const;

export interface Hints {
  /** Field that carries "This code is already used." (409 quality.code_duplicate); without it the text goes to the dialog. */
  duplicate?: string;
  duplicateText?: string;
  /** 422 quality.lot_expired. */
  expired?: { field: string; text: string };
  /** JSON pointer of a 400 field error -> form field key. */
  pointer?: (p: string) => string | undefined;
}
export interface Explained { fields: Errors; general?: string; refresh?: boolean; targetMissing?: boolean }

export function explain(r: Extract<SetupResult<unknown>, { ok: false }>, h: Hints = {}): Explained {
  const general = (g: string, extra: Partial<Explained> = {}): Explained => ({ fields: {}, general: g, ...extra });
  switch (r.code) {
    case 'auth.forbidden': return general(TEXT.forbidden);
    case 'quality.code_duplicate': return h.duplicate ? { fields: { [h.duplicate]: MSG.duplicate } } : general(h.duplicateText ?? MSG.duplicate);
    case 'quality.lot_expired': return h.expired ? { fields: { [h.expired.field]: h.expired.text } } : general(MSG.expired);
    case 'quality.qc_target_missing': return general(TEXT.targetMissing, { targetMissing: true });
    case 'quality.insufficient_qc_data': return general(TEXT.insufficient);
    case 'common.version_conflict': return general(TEXT.conflict);
    case 'common.immutable_record': return general(TEXT.immutable, { refresh: true });
    case 'common.not_found': return general(TEXT.notFound);
    case 'common.dependency_unavailable': return general(TEXT.unavailable);
    case 'common.validation_failed': {
      const fields: Errors = {};
      const rest: string[] = [];
      for (const i of r.errors ?? []) {
        const f = h.pointer?.(i.pointer);
        if (f && !fields[f]) fields[f] = i.message;
        else rest.push(i.message);
      }
      return rest.length || !Object.keys(fields).length ? { fields, general: rest.join(' ') || TEXT.invalid } : { fields };
    }
  }
  if (r.status === 412 || r.status === 428) return general(TEXT.conflict);
  return general(TEXT.generic);
}

/** One server-action attempt: Idempotency-Key per distinct body (a retry re-sends it), success toast + router.refresh(), plain-language errors per field or for the whole form. */
export function useSetupAction() {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const busy = useRef(false);
  const [errors, setErrors] = useState<Errors>({});
  const [general, setGeneral] = useState<string>();
  const [targetMissing, setTargetMissing] = useState(false);
  const reset = () => { setErrors({}); setGeneral(undefined); setTargetMissing(false); };
  const run = async <T,>(sig: string, call: (key: string) => Promise<SetupResult<T>>, o: { ok: string; hints?: Hints; onOk?: (d: T) => void }): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      const r = await call(key.keyFor(sig));
      if (r.ok) {
        key.done();
        reset();
        toast.show({ tone: 'success', title: o.ok });
        o.onOk?.(r.data);
        router.refresh();
        return true;
      }
      const x = explain(r, o.hints);
      setErrors(x.fields);
      setGeneral(x.general);
      setTargetMissing(!!x.targetMissing);
      if (x.refresh) router.refresh();
      return false;
    } finally {
      busy.current = false;
    }
  };
  return { errors, setErrors, general, targetMissing, run, reset };
}

/** Form-level message under the fields (role alert so it is announced). */
export const FormMessage = ({ text }: { text: string | undefined }) => (text ? <p role="alert" className="lims-error">{text}</p> : null);

// ---------------------------------------------------------------- dialog frame
export function FormDialog({ title, onClose, size = 'md', submitLabel, variant = 'primary', onSubmit, general, extra, children }: {
  title: string; onClose: () => void; size?: 'sm' | 'md' | 'lg'; submitLabel: string; variant?: 'primary' | 'danger'; onSubmit: () => Promise<void> | void; general?: string | undefined; extra?: ReactNode; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // 04-UI-UX §1: a dialog opens on its first field (the kit frame would focus its own close button first)
  useEffect(() => { box.current?.querySelector<HTMLElement>('input:not([readonly]):not([disabled]),textarea,button[aria-haspopup]')?.focus(); }, []);
  return (
    <Dialog title={title} isOpen onClose={onClose} size={size}>
      <div ref={box}>
        <Form onSubmit={onSubmit} errorSummary={false}>
          {children}
          <FormMessage text={general} />
          {extra}
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant={variant} type="submit" shortcut="Ctrl+Enter">{submitLabel}</Button>
        </Form>
      </div>
    </Dialog>
  );
}

/** Reason-for-change dialog: plan deactivate, target retire (1–500 characters). */
export function ReasonDialog({ title, label = 'Reason', submitLabel, variant = 'danger', general, onClose, onSubmit }: {
  title: string; label?: string; submitLabel: string; variant?: 'primary' | 'danger'; general?: string | undefined; onClose: () => void; onSubmit: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog title={title} size="sm" submitLabel={submitLabel} variant={variant} onClose={onClose} general={general} onSubmit={() => onSubmit(reason.trim())}>
      <TextField label={label} name="reason" isRequired maxLength={500} value={reason} onChange={setReason} />
    </FormDialog>
  );
}

// ---------------------------------------------------------------- pickers (C7 instruments, C3 tests) with permission fallback
export function InstrumentPicker({ enabled, value, onChange, error }: { enabled: boolean; value: Picked | undefined; onChange: (v: Picked | undefined) => void; error?: string | undefined }) {
  const [degraded, setDegraded] = useState(false);
  if (!enabled || degraded) {
    return <TextField label="Instrument ID" name="instrument_id" maxLength={36} value={value?.id ?? ''} onChange={(t) => onChange(t.trim() ? { id: t.trim(), label: t.trim() } : undefined)} {...err(error)} />;
  }
  return (
    <Combobox<Picked>
      label="Instrument" name="instrument" value={value} onChange={onChange} getKey={(p) => p.id} renderOption={(p) => p.label} renderValue={(p) => p.label}
      {...desc(value ? `Selected: ${value.label}` : undefined)} {...err(error)}
      loadOptions={async (q) => {
        const r = await searchInstrumentsAction(q);
        if (!r.ok) { setDegraded(true); return []; }
        return r.data;
      }}
    />
  );
}

export function TestAnalytePicker({ enabled, test, onTest, analyte, onAnalyte, testError, analyteError }: {
  enabled: boolean; test: Picked | undefined; onTest: (v: Picked | undefined) => void; analyte: string | undefined; onAnalyte: (v: string | undefined) => void; testError?: string | undefined; analyteError?: string | undefined;
}) {
  const [degraded, setDegraded] = useState(false);
  const [options, setOptions] = useState<AnalyteOption[]>([]);
  const testId = test?.id;
  useEffect(() => {
    setOptions([]);
    if (!testId || degraded || !enabled) return;
    let live = true;
    void analytesOfTestAction(testId).then((r) => {
      if (!live) return;
      if (r.ok) setOptions(r.data);
      else setDegraded(true);
    });
    return () => { live = false; };
  }, [testId, degraded, enabled]);

  if (!enabled || degraded) {
    return (
      <>
        <TextField label="Test ID" name="test_id" maxLength={36} value={test?.id ?? ''} onChange={(t) => onTest(t.trim() ? { id: t.trim(), label: t.trim() } : undefined)} {...err(testError)} />
        <TextField label="Analyte ID" name="analyte_id" maxLength={36} value={analyte ?? ''} onChange={(t) => onAnalyte(t.trim() || undefined)} {...err(analyteError)} />
      </>
    );
  }
  return (
    <>
      <Combobox<Picked>
        label="Test" name="test" value={test} getKey={(p) => p.id} renderOption={(p) => p.label} renderValue={(p) => p.label}
        onChange={(v) => { onTest(v); onAnalyte(undefined); }} {...err(testError)}
        loadOptions={async (q) => {
          const r = await searchTestsAction(q);
          if (!r.ok) { setDegraded(true); return []; }
          return r.data;
        }}
      />
      <Select<string>
        key={testId ?? 'none'} label="Analyte" name="analyte" options={options.map((a) => ({ value: a.id, label: a.label }))} isDisabled={!testId}
        placeholder={testId ? 'Analyte: choose one' : 'Analyte: choose a test first'}
        {...(analyte ? { value: analyte } : {})} onChange={onAnalyte} {...err(analyteError)}
      />
    </>
  );
}

// ---------------------------------------------------------------- material / level / lot options (active ones only)
export interface LotOption { value: string; label: string; levelId: string }
export function lotOptions(materials: readonly Material[], levelIds?: ReadonlySet<string>): LotOption[] {
  return materials.filter((m) => m.is_active).flatMap((m) => m.levels.filter((l) => l.is_active && (!levelIds || levelIds.has(l.id))).flatMap((l) => (l.lots ?? []).filter((x) => x.is_active).map((x) => ({
    value: x.id, levelId: l.id, label: `${m.code} · ${l.display_name} · ${x.lot_no}${x.is_expired ? ' (expired)' : ''}`,
  }))));
}
export const levelOptions = (materials: readonly Material[]) => materials.filter((m) => m.is_active).flatMap((m) => m.levels.filter((l) => l.is_active).map((l) => ({ value: l.id, label: `${m.code} · ${l.display_name}` })));
