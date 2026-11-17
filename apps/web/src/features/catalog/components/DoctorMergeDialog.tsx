'use client';
// SCR-11 merge dialog (AC-11.3): target = verified, active doctor other than the source; the user types the SOURCE code to confirm.
// One Idempotency-Key per open (a retry after a failure repeats the same request); a second press while in flight is ignored.
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { mergeDoctorAction } from '../server/catalogActions';
import type { DoctorSummary } from '../server/types';
import { CONFLICT, MFA } from './master-ui';

export type MergeSource = { id: string; doctor_code: string; display_name: string; version?: number };

/** Small ARIA combobox over a short, already-loaded list (the kit Combobox only lists options after typing). */
function TargetCombobox({ label, options, value, onChange }: { label: string; options: readonly DoctorSummary[]; value: DoctorSummary | undefined; onChange: (d: DoctorSummary) => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const needle = text.trim().toLowerCase();
  const shown = value && text === `${value.doctor_code} — ${value.display_name}` ? options : options.filter((o) => !needle || `${o.doctor_code} ${o.display_name}`.toLowerCase().includes(needle));
  const pick = (d: DoctorSummary) => {
    onChange(d);
    setText(`${d.doctor_code} — ${d.display_name}`);
    setOpen(false);
  };
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={`${id}-in`}>{label}</label>
      <input
        id={`${id}-in`}
        className="lims-input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && shown[active] ? `${id}-o${active}` : undefined}
        autoComplete="off"
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, shown.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && open && shown[active]) { e.preventDefault(); pick(shown[active]!); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }}
      />
      {open ? (
        <ul id={`${id}-list`} role="listbox" aria-label={label} className="lims-listbox" onMouseDown={(e) => e.preventDefault()}>
          {shown.length === 0 ? <li role="presentation" className="lims-option">No matching doctor.</li> : null}
          {shown.map((o, i) => (
            <li key={o.id} id={`${id}-o${i}`} role="option" aria-selected={value?.id === o.id} className="lims-option" onClick={() => pick(o)}>
              {`${o.doctor_code} — ${o.display_name}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DoctorMergeDialog({ source, targets, onClose }: { source: MergeSource; targets: readonly DoctorSummary[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [target, setTarget] = useState<DoctorSummary>();
  const [typed, setTyped] = useState('');
  const [banner, setBanner] = useState<'conflict' | 'mfa' | 'error' | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const options = targets.filter((t) => t.is_verified && t.is_active && t.id !== source.id);
  const ready = !!target && typed === source.doctor_code; // exact: no trimming

  const submit = async () => {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setBanner(null);
    try {
      const r = await mergeDoctorAction(source.id, target.id, key, source.version);
      if (r.ok) {
        onClose();
        toast.show({ tone: 'success', title: `Merged into ${target.doctor_code}` });
        router.refresh();
      } else setBanner(r.code === 'common.version_conflict' ? 'conflict' : r.code === 'auth.mfa_required' ? 'mfa' : 'error');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Merge ${source.doctor_code} into another doctor`} isOpen onClose={onClose} size="md">
      <Form onSubmit={submit} errorSummary={false}>
        {banner === 'conflict' ? <Banner tone="warning" title={CONFLICT} action={{ label: 'Refresh', onPress: () => router.refresh() }} /> : null}
        {banner === 'mfa' ? <div role="alert"><Banner tone="warning" title={MFA} /></div> : null}
        {banner === 'error' ? <div role="alert"><Banner tone="danger" title="Could not merge. Check that the target is a verified, active doctor and try again." /></div> : null}
        <TargetCombobox label="Target doctor" options={options} value={target} onChange={setTarget} />
        <p>
          {`Past orders keep the original doctor. Reports and analytics will show ${target ? `${target.display_name} (${target.doctor_code})` : 'the target doctor'}.`}
        </p>
        <TextField label={`Type ${source.doctor_code} to confirm`} name="confirm" maxLength={20} autoComplete="off" value={typed} onChange={setTyped} />
        <Button type="submit" variant="danger" isDisabled={!ready || busy}>Merge</Button>
      </Form>
    </Dialog>
  );
}
