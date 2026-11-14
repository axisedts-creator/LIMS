'use client';
// SCR-19 Commit dialog (03-APP-FLOW F-15 steps 4–5, AC-16.5/16.6/16.7). One request commits the import (If-Match = the import's version, Idempotency-Key).
// Price lists: "Publish immediately" (default ON, F-15 step 5), stale-base checkbox (only with a `file.stale_base` warning — or after the API answered
// 409 catalog.import_stale_base), and a typed confirmation of the exact price-list code (UI-only guard, never sent). The same body keeps the same key
// (a retry after a failure is the same commit, 02-CONVENTIONS §4.5); a changed body gets a new key.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { commitImportAction } from '../server/importActions';
import type { Import, ImportCommitBody, ImportIssue, PriceListLite } from '../server/types';
import { ImportNotice, failText } from './import-shared';
import { newKey, type Fail } from './shared';

export const STALE_TEXT = 'The price list was changed after this file was exported. I want to replace it anyway.';

export function ImportCommitDialog({ row, issues, priceList, isOpen, onClose, onCommitted }: {
  row: Import;
  issues: readonly ImportIssue[];
  priceList: PriceListLite | undefined;
  isOpen: boolean;
  onClose: () => void;
  onCommitted: (r: Import) => void;
}) {
  const isList = row.kind === 'price_list';
  const versioned = isList || row.kind === 'catalog_master'; // effective-from + open drafts apply
  const code = priceList?.code;
  const [from, setFrom] = useState(() => new Date().toISOString());
  const touched = useRef(false);
  const [reason, setReason] = useState('');
  const [publish, setPublish] = useState(true);
  const [replace, setReplace] = useState(false);
  const [stale, setStale] = useState(false);
  const [staleSeen, setStaleSeen] = useState(false);
  const [typed, setTyped] = useState('');
  const [fail, setFail] = useState<Fail>();
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const attempt = useRef<{ sig: string; key: string }>(null);

  // [CONV] The kit Switch (input role="switch") exposes its state only through `checked`; mirror it to aria-checked so assistive tech and tests can read it (same approach as MirrorInvalid).
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelectorAll<HTMLInputElement>('input[role="switch"]').forEach((i) => i.setAttribute('aria-checked', String(i.checked)));
  }, [publish, replace, isOpen]);

  const showStale = isList && (staleSeen || issues.some((i) => i.issue_code === 'file.stale_base'));
  const ready = reason.trim() !== '' && (!isList || (!!code && typed === code)) && (!showStale || stale);

  const submit = async () => {
    if (inflight.current || !ready) return;
    const body: ImportCommitBody = {
      change_reason: reason,
      ...(versioned && touched.current ? { effective_from: from } : {}),
      ...(isList ? { publish } : {}),
      ...(versioned ? { replace_draft: replace } : {}),
      ...(showStale && stale ? { accept_stale_base: true } : {}),
    };
    const sig = JSON.stringify(body);
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: newKey() };
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      const r = await commitImportAction(row.id, row.version, body, attempt.current.key);
      if (r.ok) {
        attempt.current = null;
        onCommitted(r.data);
        onClose();
      } else {
        if (r.code === 'catalog.import_stale_base') setStaleSeen(true);
        setFail(r);
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog title="Commit import" isOpen={isOpen} onClose={onClose} size="md">
      <div ref={box} className="catalog-contents">
      <Form onSubmit={submit} errorSummary={false}>
        {fail ? <ImportNotice tone={fail.code === 'auth.mfa_required' ? 'warning' : 'danger'} text={failText(fail)} /> : null}
        {versioned ? <DateTimePicker label="Effective from" name="effective_from" value={from as never} onChange={(v) => { if (v) { touched.current = true; setFrom(v); } }} /> : null}
        <TextArea label="Change reason" name="change_reason" maxLength={500} isRequired value={reason} onChange={setReason} />
        {isList ? <Switch label="Publish immediately" isSelected={publish} onChange={setPublish} /> : null}
        {versioned ? <Switch label="Replace open drafts" isSelected={replace} onChange={setReplace} /> : null}
        {versioned ? <p className="lims-description">Open drafts of these items are discarded before the import is applied.</p> : null}
        {showStale ? <Checkbox label={STALE_TEXT} isSelected={stale} onChange={setStale} /> : null}
        {isList ? (
          code ? (
            <TextField label={`Type ${code} to confirm`} name="typed_confirmation" maxLength={32} value={typed} onChange={setTyped} autoComplete="off" />
          ) : (
            <p role="alert">The price list for this import could not be loaded, so it cannot be committed from here.</p>
          )
        ) : null}
        <div className="lims-inline catalog-gap-2 catalog-end">
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy} isDisabled={!ready}>Commit</Button>
        </div>
      </Form>
      </div>
    </Dialog>
  );
}
