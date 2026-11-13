'use client';
// 04-UI-UX §6.1 import dialog (AC-12.1, AC-12.3, AC-12.5). The file is only name/type/size-checked here (REQ-SEC-083); the UI never reads or parses the CSV
// (REQ-SEC-088, S-13) — the bytes go to the BFF action, which re-checks and assembles the multipart body. `auth.mfa_required` is the shell's prompt (no form error).
// One Idempotency-Key per attempt: it changes whenever a value changes (a retry of the same submit keeps it).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { Form } from '@lims/ui/components/Form';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { createBreakpointImportAction } from '../../server/actions';
import { STANDARDS, type Standard } from '../../server/types';
import { FailNotice, newKey, type Fail, type IsoUtc } from '../common';

export const TEMPLATE_HREF = '/micro/breakpoint-sets/breakpoint-template';

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [standard, setStandard] = useState<Standard>();
  const [version, setVersion] = useState('');
  const [title, setTitle] = useState('');
  const [start, setStart] = useState<IsoUtc>();
  const [attest, setAttest] = useState('');
  const [file, setFile] = useState<File>();
  const [attestError, setAttestError] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [fail, setFail] = useState<Fail>();
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const inflight = useRef(false);
  const touch = () => { key.current = newKey(); setFail(undefined); };

  const submit = async () => {
    if (inflight.current) return;
    const len = attest.trim().length;
    setAttestError(len < 20 || attest.length > 500 ? 'Enter 20 to 500 characters.' : undefined);
    setFileError(file ? undefined : 'Choose a CSV file (up to 5 MiB).');
    if (!standard || !file || len < 20 || attest.length > 500) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      const form = new FormData();
      form.set('standard', standard);
      form.set('standard_version', version);
      form.set('title', title);
      form.set('licence_attestation_text', attest);
      if (start) form.set('intended_effective_from', start);
      form.set('file', file, file.name);
      const r = await createBreakpointImportAction(form, key.current);
      if (r.ok) {
        router.push(`/micro/breakpoint-sets/${r.data.id}`); // stays locked: no second upload of the same file while navigating
        return;
      }
      setFail(r);
    } catch (e) {
      inflight.current = false;
      setBusy(false);
      throw e;
    }
    inflight.current = false;
    setBusy(false);
  };

  return (
    <Dialog title="Import breakpoint table" isOpen onClose={onClose} size="md">
      <FailNotice fail={fail} />
      <Form onSubmit={submit}>
        <Select<Standard> label="Standard" name="standard" isRequired {...(standard ? { value: standard } : {})} onChange={(v) => { setStandard(v); touch(); }} options={STANDARDS.map((s) => ({ value: s, label: s }))} />
        <TextField label="Version" name="standard_version" isRequired maxLength={32} description="As printed on your source, e.g. the edition" value={version} onChange={(v) => { setVersion(v); touch(); }} />
        <TextField label="Title" name="title" isRequired maxLength={120} value={title} onChange={(v) => { setTitle(v); touch(); }} />
        <DateTimePicker label="Intended start (optional)" name="intended_effective_from" description="Used as the default start when the table is activated." {...(start ? { value: start } : {})} onChange={(v) => { setStart(v); touch(); }} />
        <TextArea label="Describe your laboratory's right to use this table" name="licence_attestation_text" isRequired maxLength={500} value={attest} {...(attestError ? { error: attestError } : {})} onChange={(v) => { setAttest(v); setAttestError(undefined); touch(); }} />
        <FileUpload
          label="File"
          name="file"
          accept={['text/csv']}
          maxBytes={5242880}
          description="CSV (UTF-8), up to 5 MiB."
          {...(fileError ? { error: fileError } : {})}
          onSelect={(f) => { setFile(f[0]); setFileError(undefined); touch(); inflight.current = false; setBusy(false); }}
        />
        <a className="lims-link" href={TEMPLATE_HREF}>Download template</a>
        <Button type="submit" variant="primary" isLoading={busy}>Upload</Button>
      </Form>
    </Dialog>
  );
}
