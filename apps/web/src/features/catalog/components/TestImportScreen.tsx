'use client';
// T0D-TESTIMPORT-1 (LD-318, founder 2026-11-17 08:58 NPT; LD-353 template 6 on one screen): Excel "Import tests" at /catalog/imports?view=tests (no new
// route, rs-c2). Four steps: Download template, Choose file (kit FileUpload = the standard upload helper; the pick starts the server dry run), Validate (counts +
// errors table), Commit (only a validated batch of the current file and mode with zero errors; DRAFTS only, a pathologist publishes). Then the history.
// The browser never parses the workbook (the server does) and never calls the API (server actions). All error text shown is the server's own.
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Dialog } from '@lims/ui/components/Dialog';
import { FileUpload, type FileUploadProps } from '@lims/ui/components/FileUpload';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import type { TestImportBatch, TestImportCommitResult, TestImportError, TestImportMode, TestImportValidation } from '../server/testImport.server';
import { commitTestImportAction, testImportErrorsAction, testImportTemplateAction, validateTestImportAction } from '../server/testImportActions';
import { MasterTable, type Col } from './master-ui';
import { fmtDateTime, newKey } from './shared';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES = 5 * 1024 * 1024; // validateCatalogImport: at most 5 MB
export const TEMPLATE_VERSION = '1'; // services/api import/fields.ts TEMPLATE_VERSION
const TEMPLATE_FILE = `test-import-template-v${TEMPLATE_VERSION}.xlsx`;
const PAGE = 25;
const MODE_LABEL: Record<TestImportMode, string> = { create_only: 'Create only', update: 'Update existing' };
const STATUS_LABEL: Record<string, string> = { validated: 'Validated', rejected: 'Rejected', committed: 'Committed', expired: 'Expired' };
const PUBLISH = 'A pathologist must publish the drafts before the tests can be ordered.';
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

function save(name: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const Alert = ({ text }: { text: string }) => <div role="alert" className="lims-error"><p>{text}</p></div>;

type SendControl = Parameters<NonNullable<FileUploadProps['uploadFile']>>[1];
type ErrRow =TestImportError & { id: string };

export function TestImportScreen({ history }: { history: readonly TestImportBatch[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<TestImportMode>('create_only');
  const [tplFail, setTplFail] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [upFail, setUpFail] = useState<string>();
  const [result, setResult] = useState<TestImportValidation>();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [errFail, setErrFail] = useState<string>();
  const [open, setOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitFail, setCommitFail] = useState<string>();
  const [committed, setCommitted] = useState<TestImportCommitResult>();
  const pick = useRef({ seq: 0, key: '', mode: 'create_only' as TestImportMode });
  const inflight = useRef(false);
  const commitKey = useRef<{ batch: string; key: string }>(null);

  const downloadTemplate = async () => {
    setTplFail(undefined);
    const r = await testImportTemplateAction().catch(() => undefined);
    if (r?.ok) save(TEMPLATE_FILE, r.data);
    else setTplFail('The template could not be downloaded. Try again.');
  };

  // FileUpload calls onSelect, then uploadFile for every attempt of the same pick: one Idempotency-Key per pick, the same key on each retry.
  const onSelect = () => {
    pick.current = { seq: pick.current.seq + 1, key: newKey(), mode };
    setResult(undefined); setUpFail(undefined); setCommitFail(undefined); setCommitted(undefined); setErrFail(undefined); setQ(''); setPage(0);
    setUploading(true);
  };
  const uploadFile = async (file: File, c: SendControl) => {
    const { seq, key, mode: m } = pick.current;
    const form = new FormData();
    form.set('file', file, file.name);
    form.set('mode', m);
    const r = await validateTestImportAction(form, key);
    const stale = c.signal.aborted || seq !== pick.current.seq;
    if (r.ok) {
      c.onProgress(100);
      if (!stale) { setResult(r.data); setUploading(false); router.refresh(); }
      return;
    }
    if (r.status >= 500 && c.attempt <= 3) throw new Error(r.code); // retried by the kit queue with the same key
    if (!stale) { setUpFail(r.detail ?? 'The file could not be checked. Try again.'); setUploading(false); }
    throw Object.assign(new Error(r.code), { retryable: false });
  };

  const errors: ErrRow[] = useMemo(() => (result?.errors ?? []).map((e, i) => ({ ...e, id: String(i) })), [result]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? errors.filter((e) => [e.sheet, String(e.row), e.column, e.message].some((v) => v.toLowerCase().includes(needle))) : errors;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const at = Math.min(page, pages - 1);
  const counts = result?.batch.counts;
  const batch = result?.batch;
  const canCommit = !!batch && !uploading && !committed && !committing && batch.status === 'validated' && batch.counts.errors === 0 && errors.length === 0 && batch.mode === mode;

  const downloadErrors = async () => {
    if (!batch) return;
    setErrFail(undefined);
    const r = await testImportErrorsAction(batch.id).catch(() => undefined);
    if (r?.ok) save('test-import-errors.xlsx', r.data);
    else setErrFail('The errors file could not be downloaded. Try again.');
  };

  const commit = async () => {
    if (inflight.current || !canCommit || !batch) return;
    inflight.current = true;
    setOpen(false);
    setCommitting(true);
    setCommitFail(undefined);
    if (commitKey.current?.batch !== batch.id) commitKey.current = { batch: batch.id, key: newKey() };
    try {
      const r = await commitTestImportAction(batch.id, batch.version, commitKey.current.key);
      if (r.ok) { setCommitted(r.data); router.refresh(); }
      else setCommitFail(r.detail ?? 'The import could not be committed. Try again.');
    } finally {
      inflight.current = false;
      setCommitting(false);
    }
  };

  const errCols: Col<ErrRow>[] = [
    { header: 'Sheet', cell: (r) => r.sheet },
    { header: 'Row', cell: (r) => String(r.row) },
    { header: 'Column', cell: (r) => r.column },
    { header: 'Problem', cell: (r) => r.message },
  ];
  const histCols: Col<TestImportBatch>[] = [
    { header: 'File', cell: (r) => r.file_name },
    { header: 'Uploaded by', cell: (r) => r.created_by.slice(0, 8) },
    { header: 'Time', cell: (r) => fmtDateTime(r.created_at) || '—' },
    { header: 'Mode', cell: (r) => MODE_LABEL[r.mode] ?? r.mode },
    { header: 'Tests', cell: (r) => String(r.counts.tests) },
    { header: 'Parameters', cell: (r) => String(r.counts.analytes) },
    { header: 'Ranges', cell: (r) => String(r.counts.ranges) },
    { header: 'Errors', cell: (r) => String(r.counts.errors) },
    { header: 'Status', cell: (r) => STATUS_LABEL[r.status] ?? r.status },
    { header: 'Committed at', cell: (r) => fmtDateTime(r.committed_at) || '—' },
  ];
  const emptyErrors = !result ? 'Choose a file to see its errors here.' : errors.length === 0 ? 'No errors in this file.' : 'No errors match the filter.';
  const what = counts ? `${n(counts.tests, 'test')}, ${n(counts.analytes, 'parameter')}, ${n(counts.ranges, 'reference range')} and ${n(counts.panels, 'panel')}` : '';

  return (
    <section aria-label="Import tests" className="lims-stack">{/* density: compact comes from the shell wrapper (T0D-DENSITY-1) */}
      <PageHeader title="Import tests" helpKey="catalog.imports" />

      <Card title="Download template" region>
        <div className="lims-stack">
        <p className="lims-description">Fill the template in Excel: the same fields as the Add Test, Add Test Parameter and Reference Range forms. File: {TEMPLATE_FILE}</p>
        <div><Button variant="secondary" onPress={() => void downloadTemplate()}>Download template</Button></div>
        {tplFail ? <Alert text={tplFail} /> : null}
        </div>
      </Card>

      <Card title="Choose file" region>
        <div className="lims-stack">
        <RadioGroup<TestImportMode>
          label="Mode"
          name="mode"
          orientation="horizontal"
          value={mode}
          onChange={setMode}
          options={[{ value: 'create_only', label: MODE_LABEL.create_only }, { value: 'update', label: MODE_LABEL.update }]}
        />
        {mode === 'update' ? (
          <div role="note" className="lims-banner lims-banner-warning">
            Update existing adds new draft versions to existing tests with the same code. Nothing goes live until a pathologist publishes the drafts.
          </div>
        ) : null}
        <FileUpload
          label="Excel file"
          name="file"
          accept={[XLSX]}
          maxBytes={MAX_BYTES}
          description="Excel .xlsx only, up to 5 MB. Drag the file here or browse. The file is checked as soon as it is chosen."
          onSelect={onSelect}
          uploadFile={uploadFile}
        />
        {upFail ? <Alert text={upFail} /> : null}
        {batch && batch.mode !== mode ? <p className="lims-description">This file was checked as {MODE_LABEL[batch.mode]}. Choose the file again to check it as {MODE_LABEL[mode]}.</p> : null}
        </div>
      </Card>

      <Card title="Validate" region>
        <div className="lims-stack">
        <dl className="lims-inline catalog-gap-3">
          {([['Tests', counts?.tests], ['Parameters', counts?.analytes], ['Ranges', counts?.ranges], ['Panels', counts?.panels], ['Errors', counts?.errors]] as const).map(([l, v]) => (
            <div key={l}><dt>{l}</dt><dd>{v ?? 0}</dd></div>
          ))}
        </dl>
        {/* T0D-UIGUARD-1-CATALOG (LD-353 rule 2): the error filter is the kit FilterBar; the download sits after it */}
        <FilterBar
          filters={[{ id: 'error_filter', label: 'Filter errors', kind: 'text', maxLength: 100 }]}
          value={{ error_filter: q }}
          onChange={(v) => { setQ(typeof v['error_filter'] === 'string' ? v['error_filter'] : ''); setPage(0); }}
          onReset={() => { setQ(''); setPage(0); }}
          resetLabel="Clear filters"
        />
        <div><Button variant="secondary" isDisabled={errors.length === 0} onPress={() => void downloadErrors()}>Download errors file</Button></div>
        {errFail ? <Alert text={errFail} /> : null}
        <MasterTable caption="Problems found in the file" cols={errCols} rows={shown.slice(at * PAGE, at * PAGE + PAGE)} empty={emptyErrors} />
        <div className="lims-inline catalog-gap-2">
          <Button size="sm" variant="ghost" isDisabled={at === 0} onPress={() => setPage(at - 1)}>Previous</Button>
          <span>Page {at + 1} of {pages}</span>
          <Button size="sm" variant="ghost" isDisabled={at >= pages - 1} onPress={() => setPage(at + 1)}>Next</Button>
        </div>
        </div>
      </Card>

      <Card title="Commit" region>
        <div className="lims-stack">
        <p className="lims-description">Commit is possible once the file has no errors. Everything is created as drafts. {PUBLISH}</p>
        <div><Button variant="primary" isDisabled={!canCommit} onPress={() => setOpen(true)}>Commit</Button></div>
        {commitFail ? <Alert text={commitFail} /> : null}
        </div>
      </Card>

      <Dialog title="Create drafts from this file" isOpen={open} onClose={() => setOpen(false)} size="md"
        footer={<>
          <Button variant="ghost" onPress={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onPress={() => void commit()}>Create drafts</Button>
        </>}>
        <p>{mode === 'update' ? `This adds new draft versions to existing tests: ${what}.` : `This creates ${what} as drafts.`}</p>
        <p>Nothing is published. {PUBLISH}</p>
      </Dialog>

      {committed ? (
        <Card title="Import result" region>
          <div className="lims-stack">
          <p role="status">
            Created as drafts: {n(committed.created.tests, 'test')}, {n(committed.created.analytes, 'parameter')}, {n(committed.created.ranges, 'reference range')}, {n(committed.created.panels, 'panel')}. {PUBLISH}
          </p>
          {/* T0D-UIGUARD-1-CATALOG (LD-436 R7): list semantics by role, no raw ul */}
          <div role="list" className="lims-stack">
            {(result?.preview.tests ?? []).map((t) => (
              <div role="listitem" key={t.code}><a className="lims-link" href={`/catalog/tests?q=${encodeURIComponent(t.code)}`}>{t.code}</a> {t.name}</div>
            ))}
          </div>
          </div>
        </Card>
      ) : null}

      <Card title="Import history" region>
        <div className="lims-stack">
        <MasterTable caption="Import history" cols={histCols} rows={history} empty="No test imports yet." />
        </div>
      </Card>
    </section>
  );
}
