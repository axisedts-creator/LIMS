'use client';
// SR-06 Wording terms (04-UI-UX SR-06; #23–#25). Global rows never get an action (AC-18.2); tenant rows can be deactivated (If-Match). Text nodes only.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { addTermAction, deactivateTermAction } from '../server/actions';
import { TERM_LANG_LABEL, newKey, type Term } from '../library';

const EMPTY = 'No lab-specific terms. Global terms always apply.';
// [CONV] inputs accept more than the limits so an over-long paste is reported, not silently cut.
const INPUT_CAP = 1000;

function failText(r: { status: number; code: string }, what: string) {
  if (r.status === 404) return 'This term was not found or can no longer be changed.';
  if (r.status === 409) return 'This term was changed by someone else, or the request was repeated. Reload to see the latest.';
  if (r.status === 400 || r.status === 422) return 'Some values were not accepted. Check the term, language and reason.';
  if (r.status === 403) return 'You do not have permission to change wording terms.';
  return `Could not ${what}. Try again.`;
}

export function WordingTerms({ rows }: { rows: Term[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<Term>();
  const [alert, setAlert] = useState<string>();
  const hasTenant = rows.some((t) => t.scope === 'tenant');

  const deactivate = async () => {
    if (!target?.id || target.version === undefined) return;
    const r = await deactivateTermAction(target.id, target.version);
    setTarget(undefined);
    if (r.ok) { setAlert(undefined); router.refresh(); } else setAlert(failText(r, 'deactivate the term'));
  };

  const columns: ColumnDef<Term>[] = [
    { id: 'term', header: 'Term', isRowHeader: true, cell: (t) => t.term },
    { id: 'language', header: 'Language', cell: (t) => TERM_LANG_LABEL[t.language] ?? t.language },
    { id: 'scope', header: 'Scope', cell: (t) => (t.scope === 'global' ? 'Global' : 'This lab') },
    { id: 'reason', header: 'Reason', cell: (t) => t.reason ?? '—' },
    { id: 'active', header: 'Active', cell: (t) => ` ${t.is_active ? 'Yes' : 'No'} ` }, // padded: the row's text reads "… reason Yes Deactivate …", not "…reasonYesDeactivate…"
    {
      id: 'actions', header: 'Actions',
      cell: (t) => (t.scope === 'tenant' && t.is_active && t.id && t.version !== undefined
        ? <Button size="sm" variant="ghost" onPress={() => setTarget(t)}>{`Deactivate ${t.term}`}</Button>
        : null),
    },
  ];

  return (
    <>
      <PageHeader title="Wording terms" helpKey="smartreport.wording" actions={<Button variant="primary" onPress={() => setAdding(true)}>Add term</Button>} />
      {alert ? <div role="alert"><Banner tone="danger" title={alert} /></div> : null}
      {hasTenant ? null : <p>{EMPTY}</p>}
      {rows.length ? (
        <DataTable<Term> columns={columns} rows={rows} getRowId={(t) => `${t.scope}:${t.id ?? t.term}:${t.language}`} caption="Wording terms" density="compact" emptyState={{ title: EMPTY }} />
      ) : null}
      <ConfirmDialog
        title="Deactivate this term?" confirmLabel="Deactivate" tone="danger" isOpen={!!target} onCancel={() => setTarget(undefined)} onConfirm={deactivate}
        body={<p>Texts that contain this term will no longer be flagged. Earlier checks are not changed.</p>}
      />
      {adding ? <AddTerm onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function AddTerm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [language, setLanguage] = useState<string>();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [alert, setAlert] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const idem = useRef<{ key: string; sig: string }>({ key: newKey(), sig: '' });

  const t = term.trim();
  const errs = {
    term: tried && (t.length < 2 || t.length > 60) ? 'Term must be 2–60 characters.' : undefined,
    language: tried && !language ? 'Language is required.' : undefined,
    reason: reason.length > 200 ? 'Reason must be 200 characters or fewer.' : undefined,
  };

  const save = async () => {
    if (inFlight.current) return;
    setTried(true); setAlert(undefined);
    if (t.length < 2 || t.length > 60 || !language || reason.length > 200) return;
    const body = { term: t, language, ...(reason.trim() ? { reason: reason.trim() } : {}) };
    // the Idempotency-Key is kept for a retry of the SAME body and renewed as soon as the input changes
    const sig = JSON.stringify(body);
    if (idem.current.sig !== sig) idem.current = { key: newKey(), sig };
    inFlight.current = true; setBusy(true);
    try {
      const r = await addTermAction(body, idem.current.key);
      if (r.ok) { toast.show({ tone: 'success', title: 'Term added' }); onClose(); router.refresh(); } else setAlert(failText(r, 'add the term'));
    } finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <Dialog
      title="Add wording term" isOpen onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant="primary" isLoading={busy} onPress={() => void save()}>Add term</Button>
        </>
      )}
    >
      {alert ? <div role="alert"><Banner tone="danger" title={alert} /></div> : null}
      <TextField label="Term" name="term" maxLength={INPUT_CAP} value={term} onChange={setTerm} {...(errs.term ? { error: errs.term } : {})} />
      <Select<string>
        label="Language" name="language" options={[{ value: 'en', label: 'English' }, { value: 'ne', label: 'Nepali' }, { value: 'any', label: 'Any' }]}
        {...(language ? { value: language } : {})} onChange={setLanguage} {...(errs.language ? { error: errs.language } : {})}
      />
      <TextArea label="Reason (optional)" name="reason" maxLength={INPUT_CAP} showCount={false} value={reason} onChange={setReason} {...(errs.reason ? { error: errs.reason } : {})} />
    </Dialog>
  );
}
