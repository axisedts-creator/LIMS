'use client';
// T0D-PRICETOOLS-1 (LD-321, LD-353 template 1; ElabAssist Price Allocation / Rate Master): the price list tools on SCR-13 detail.
//   "Upload and check": Download template, the kit FileUpload (xlsx, 5 MB; the pick starts the server dry run, which writes nothing), the counts and the
//   table Row / Column / Code / Message with EVERY error (no paging), then "Commit to draft" (only the current file's clean dry run) -> a DRAFT version.
//   "Import history": the batches of this list. "Copy to": the dialog that copies a version into a new DRAFT of another list.
// The browser never parses the workbook and never calls the API (server actions); every error text shown is the server's own `detail`.
import { useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { t } from '@/core/i18n/messages';
import type { PriceImportBatch, PriceImportDryRun } from '../server/priceTools.server';
import { commitPriceImportAction, copyPriceListAction, dryRunPriceImportAction, priceTemplateAction, searchPriceListsAction } from '../server/pricingActions';
import type { PriceListDetail, PriceListVersion } from '../server/types';
import { parsePercentBp, ROUNDINGS, saveBase64, XLSX, type Rounding } from './priceToolsMath';
import { fmtDateTime, newKey, STATUS_LABEL } from './shared';

const MAX_BYTES = 5 * 1024 * 1024; // dryRunPriceListImport: at most 5 MB (the server re-checks)
const okFile = (f: File) => f.type === XLSX && /\.xlsx$/i.test(f.name) && f.size > 0 && f.size <= MAX_BYTES;
const Alert = ({ text }: { text: string }) => <div role="alert" className="lims-error"><p>{text}</p></div>;
const draftHref = (listId: string, versionId: string) => `/catalog/price-lists/${listId}/versions/${versionId}`;
export const ROUNDING_OPTIONS = ROUNDINGS.map((value) => ({ value, label: t(`catalog.price_tools.rounding.${value}`) }));

/** Download template (no list) and Export to Excel (this list's prices): one request at a time, a failure is an alert in the Upload and check section. */
export function useTemplateDownload(priceList: { id: string; code: string }) {
  const [fail, setFail] = useState(false);
  const busy = useRef(false);
  const doneAt = useRef(0);
  const run = async (withList: boolean) => {
    // [CONV] a press while one runs, or within 500 ms after a download (the second half of a double click), is ignored.
    if (busy.current || Date.now() - doneAt.current < 500) return;
    busy.current = true;
    setFail(false);
    try {
      const r = await priceTemplateAction(withList ? priceList.id : undefined).catch(() => undefined);
      if (r?.ok) {
        saveBase64(withList ? `price-list-${priceList.code.toLowerCase()}.xlsx` : 'price-list-template.xlsx', r.data);
        doneAt.current = Date.now();
      } else setFail(true);
    } finally {
      busy.current = false;
    }
  };
  return { fail, run };
}

export function UploadAndCheck({ priceList, manage, tpl, sectionRef }: {
  priceList: Pick<PriceListDetail, 'id' | 'code'>;
  manage: boolean;
  tpl: ReturnType<typeof useTemplateDownload>;
  sectionRef: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [refused, setRefused] = useState(false);
  const [uploading, setUploading] = useState<string>();
  const [fail, setFail] = useState<{ text: string; retry: boolean }>();
  const [result, setResult] = useState<PriceImportDryRun>();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [commitFail, setCommitFail] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<PriceListVersion>();
  // One Idempotency-Key per pick (a retry of the same pick reuses it); `seq` makes a cancelled or replaced upload's late answer harmless.
  const pick = useRef<{ seq: number; key: string; file?: File }>({ seq: 0, key: '' });
  const inflight = useRef(false);
  const commitKey = useRef<{ batch: string; key: string }>(null);

  const send = async () => {
    const { seq, key, file } = pick.current;
    if (!file) return;
    setFail(undefined);
    setUploading(file.name);
    const form = new FormData();
    form.set('file', file, file.name);
    const r = await dryRunPriceImportAction(priceList.id, form, key).catch(() => undefined);
    if (seq !== pick.current.seq) return; // cancelled or replaced: ignore the late answer
    setUploading(undefined);
    if (r?.ok) {
      setResult(r.data);
      router.refresh(); // the history shows the new batch
    } else setFail({ text: r?.detail ?? t('catalog.price_tools.upload.failed'), retry: !r || r.status >= 500 });
  };
  const onSelect = (files: readonly File[]) => {
    const f = files[0];
    if (!f || !okFile(f)) return setRefused(true);
    setRefused(false);
    pick.current = { seq: pick.current.seq + 1, key: newKey(), file: f };
    setResult(undefined); setCommitted(undefined); setCommitFail(undefined);
    void send();
  };
  const cancel = () => {
    pick.current = { ...pick.current, seq: pick.current.seq + 1 };
    setUploading(undefined);
  };

  const batch = result?.batch;
  const errors = result?.errors ?? [];
  const clean = !!batch && batch.status === 'dry_run' && batch.error_count === 0 && errors.length === 0;
  const canCommit = manage && clean && !uploading && !committed && !committing;

  const commit = async () => {
    if (inflight.current || !canCommit || !batch || !reason.trim()) return;
    inflight.current = true;
    setCommitting(true);
    setCommitFail(undefined);
    if (commitKey.current?.batch !== batch.id) commitKey.current = { batch: batch.id, key: newKey() };
    try {
      const r = await commitPriceImportAction(batch.id, reason.trim(), commitKey.current.key).catch(() => undefined);
      if (r?.ok) {
        setCommitted(r.data);
        setOpen(false);
        router.refresh();
      } else {
        if (r && r.status < 500) commitKey.current = null; // a corrected retry is a new request
        setCommitFail(r?.detail ?? t('catalog.price_tools.commit.failed'));
      }
    } finally {
      inflight.current = false;
      setCommitting(false);
    }
  };

  const s = batch?.summary;
  const counts: [string, number | undefined][] = [
    [t('catalog.price_tools.count.rows'), s?.rows ?? batch?.row_count],
    [t('catalog.price_tools.count.added'), s?.added],
    [t('catalog.price_tools.count.changed'), s?.changed],
    [t('catalog.price_tools.count.unchanged'), s?.unchanged],
    [t('catalog.price_tools.count.errors'), s?.errors ?? batch?.error_count],
  ];
  const head = ['Row', 'Column', 'Code', 'Message'];
  return (
    <section aria-labelledby="pt-upload" className="lims-stack" ref={sectionRef}>
      <h2 id="pt-upload" className="lims-section-title">{t('catalog.price_tools.upload.title')}</h2>
      <p className="lims-description">{t('catalog.price_tools.upload.hint')}</p>
      {manage ? null : <p className="lims-description">{t('catalog.price_tools.need_manage')}</p>}
      <div className="lims-inline catalog-gap-2">
        <Button variant="secondary" isDisabled={!manage} onPress={() => void tpl.run(false)}>{t('catalog.price_tools.upload.template')}</Button>
      </div>
      {tpl.fail ? <Alert text={t('catalog.price_tools.download_failed')} /> : null}
      <div onChangeCapture={(e) => { const fs = (e.target as HTMLInputElement).files; if (fs && Array.from(fs).some((f) => !okFile(f))) setRefused(true); }}>
        <FileUpload
          label={t('catalog.price_tools.upload.file')}
          name="file"
          accept={[XLSX]}
          maxBytes={MAX_BYTES}
          isDisabled={!manage}
          description={t('catalog.price_tools.upload.file_hint')}
          onSelect={onSelect}
          {...(uploading ? { progress: { [uploading]: 0 } } : {})}
        />
      </div>
      {uploading ? <div><Button size="sm" variant="ghost" onPress={cancel}>{t('catalog.price_tools.upload.cancel')}</Button></div> : null}
      {refused ? <Alert text={t('catalog.price_tools.upload.refused')} /> : null}
      {fail ? (
        <div className="lims-stack catalog-gap-2">
          <Alert text={fail.text} />
          {fail.retry ? <div><Button size="sm" onPress={() => void send()}>{t('catalog.price_tools.upload.retry')}</Button></div> : null}
        </div>
      ) : null}
      <dl className="lims-inline catalog-gap-3">
        {counts.map(([l, v]) => <div key={l}><dt>{l}</dt><dd>{v ?? '—'}</dd></div>)}
      </dl>
      <div className="lims-table-scroll">
        <table className="lims-table lims-table-compact">
          <caption className="lims-visually-hidden">{t('catalog.price_tools.errors.caption')}</caption>
          <thead><tr>{head.map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}</tr></thead>
          <tbody>
            {errors.length === 0 ? <EmptyRow colSpan={4}>{t(result ? 'catalog.price_tools.errors.none' : 'catalog.price_tools.errors.none_yet')}</EmptyRow> : null}
            {errors.map((e, i) => (
              <tr key={i} className="lims-row">
                <td className="lims-cell lims-num">{e.row_no}</td>
                <td className="lims-cell">{e.column}</td>
                <td className="lims-cell">{e.code}</td>
                <td className="lims-cell">{e.message}</td>
              </tr>
            ))}
          </tbody>
          {errors.length === 0 ? <PlaceholderRows colSpan={4} /> : null}
        </table>
      </div>
      <div className="lims-inline catalog-gap-2">
        <Button variant="primary" isDisabled={!canCommit} onPress={() => { setReason(''); setCommitFail(undefined); setOpen(true); }}>{t('catalog.price_tools.commit.button')}</Button>
        {batch && !clean ? <p className="lims-description">{t('catalog.price_tools.commit.fix_errors')}</p> : null}
      </div>
      {committed ? (
        <p role="status">
          {t('catalog.price_tools.draft_created')} <a className="lims-link" href={draftHref(priceList.id, committed.id)}>{t('catalog.price_tools.open_draft')}</a>
        </p>
      ) : null}
      <Dialog title={t('catalog.price_tools.commit.title')} isOpen={open} onClose={() => setOpen(false)} size="md"
        footer={<>
          <Button variant="ghost" onPress={() => setOpen(false)}>{t('catalog.price_tools.cancel')}</Button>
          <Button variant="primary" isDisabled={!reason.trim()} isLoading={committing} onPress={() => void commit()}>{t('catalog.price_tools.commit.confirm')}</Button>
        </>}>
        <div className="lims-stack">
          <p>{t('catalog.price_tools.commit.explain')}</p>
          <TextArea label={t('catalog.price_tools.change_reason')} name="change_reason" maxLength={500} isRequired value={reason} onChange={setReason} />
          {commitFail ? <Alert text={commitFail} /> : null}
        </div>
      </Dialog>
    </section>
  );
}

const BATCH_STATUS = (s: string) => t(`catalog.price_tools.status.${s}`);

export function ImportHistory({ priceListId, history }: { priceListId: string; history: readonly PriceImportBatch[] | null }) {
  const head = ['Time', 'Uploaded by', 'Status', 'Rows', 'Errors', 'Draft'];
  return (
    <section aria-labelledby="pt-history" className="lims-stack">
      <h2 id="pt-history" className="lims-section-title">{t('catalog.price_tools.history.title')}</h2>
      {history === null ? <p className="lims-description">{t('catalog.price_tools.history.hidden')}</p> : (
        <div className="lims-table-scroll">
          <table className="lims-table lims-table-compact">
            <caption className="lims-visually-hidden">{t('catalog.price_tools.history.title')}</caption>
            <thead><tr>{head.map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}</tr></thead>
            <tbody>
              {history.length === 0 ? <EmptyRow colSpan={6}>{t('catalog.price_tools.history.empty')}</EmptyRow> : null}
              {history.map((b) => (
                <tr key={b.id} className="lims-row">
                  <td className="lims-cell">{fmtDateTime(b.created_at) || '—'}</td>
                  <td className="lims-cell" title={b.created_by}>{b.created_by.slice(0, 8)}</td>
                  <td className="lims-cell">{BATCH_STATUS(b.status)}</td>
                  <td className="lims-cell lims-num">{b.row_count}</td>
                  <td className="lims-cell lims-num">{b.error_count}</td>
                  <td className="lims-cell">{b.result_price_list_version_id ? <a className="lims-link" href={draftHref(priceListId, b.result_price_list_version_id)}>{t('catalog.price_tools.open_draft')}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
            {history.length === 0 ? <PlaceholderRows colSpan={6} /> : null}
          </table>
        </div>
      )}
    </section>
  );
}

interface Target { id: string; label: string }

/** Copy to: the chosen version of THIS list becomes a new DRAFT of the target list (replace or merge, optional percent and rounding). */
export function CopyToDialog({ priceList, onClose, onDone }: { priceList: PriceListDetail; onClose: () => void; onDone: (targetId: string, v: PriceListVersion) => void }) {
  const versions = priceList.versions.filter((v) => v.status !== 'discarded');
  const [target, setTarget] = useState<Target>();
  const [versionId, setVersionId] = useState(priceList.current_version?.id ?? versions[0]?.id ?? '');
  const [mode, setMode] = useState<'replace' | 'merge'>();
  const [percent, setPercent] = useState('');
  const [rounding, setRounding] = useState<Rounding>('none');
  const [fail, setFail] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const key = useRef<string>(undefined);
  const bp = percent.trim() ? parsePercentBp(percent) : undefined;
  const percentBad = percent.trim() !== '' && bp === undefined;
  const ready = !!target && !!mode && !!versionId && !percentBad;

  const copy = async () => {
    if (inflight.current || !ready || !target || !mode) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    key.current ??= newKey();
    try {
      const body = { source_price_list_version_id: versionId, mode, ...(bp !== undefined ? { percent_bp: bp, rounding } : {}) };
      const r = await copyPriceListAction(target.id, body, key.current).catch(() => undefined);
      if (r?.ok) {
        key.current = undefined;
        onDone(target.id, r.data);
        onClose();
      } else {
        if (r && r.status < 500) key.current = undefined; // a 5xx retry reuses the key: never a second draft
        setFail(r?.detail ?? t('catalog.price_tools.copy.failed'));
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const versionLabel = (v: PriceListVersion) => `v${v.version_no} · ${STATUS_LABEL[v.status] ?? v.status}${v.id === priceList.current_version?.id ? ` (${t('catalog.price_tools.compare.current')})` : ''}`;
  return (
    <Dialog title={t('catalog.price_tools.copy_to')} isOpen onClose={onClose} size="md"
      footer={<>
        <Button variant="ghost" onPress={onClose}>{t('catalog.price_tools.cancel')}</Button>
        <Button variant="primary" isDisabled={!ready} isLoading={busy} onPress={() => void copy()}>{t('catalog.price_tools.copy.confirm')}</Button>
      </>}>
      <div className="lims-stack">
        <p className="lims-description">{t('catalog.price_tools.copy.draft_hint')}</p>
        <Combobox<Target>
          label={t('catalog.price_tools.copy.target')}
          name="target_price_list"
          isRequired
          value={target}
          loadOptions={async (q) => (await searchPriceListsAction(q)).filter((o) => o.id !== priceList.id)}
          getKey={(o) => o.id}
          renderOption={(o) => o.label}
          renderValue={(o) => o.label}
          onChange={setTarget}
        />
        <Select<string> label={t('catalog.price_tools.copy.version')} name="source_version" value={versionId} onChange={setVersionId} options={versions.map((v) => ({ value: v.id, label: versionLabel(v) }))} />
        <RadioGroup<'replace' | 'merge'>
          label={t('catalog.price_tools.copy.mode')}
          name="copy_mode"
          isRequired
          orientation="horizontal"
          description={t('catalog.price_tools.copy.mode_hint')}
          {...(mode ? { value: mode } : {})}
          onChange={setMode}
          options={[{ value: 'replace', label: t('catalog.price_tools.copy.replace') }, { value: 'merge', label: t('catalog.price_tools.copy.merge') }]}
        />
        <TextField label={t('catalog.price_tools.copy.percent')} name="percent" maxLength={8} inputMode="decimal" value={percent} onChange={setPercent} {...(percentBad ? { error: t('catalog.price_tools.percent_invalid') } : {})} />
        <Select<Rounding> label={t('catalog.price_tools.rounding')} name="rounding" value={rounding} onChange={setRounding} options={ROUNDING_OPTIONS} />
        {fail ? <Alert text={fail} /> : null}
      </div>
    </Dialog>
  );
}
