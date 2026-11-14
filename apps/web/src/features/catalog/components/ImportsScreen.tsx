'use client';
// SCR-18 Imports & exports (04-UI-UX §4; 03-APP-FLOW F-15 steps 1–2, F-16). Kind choices follow the kind permission (08 A13 P-10; the API enforces).
// Upload: one Idempotency-Key per selected file; the file is only name/type/size-checked here (REQ-SEC-083). Downloads go through the BFF proxies
// (REQ-SEC-085); a 409 file_not_ready shows "Still preparing". Exports poll every 2 s until ready (F-16 step 2), at most 15 min.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { useToast } from '@lims/ui/components/Toast';
import { createExportAction, createImportAction, pollExportAction } from '../server/importActions';
import { IMPORT_STATUSES, EXPORT_STATUSES, IMPORT_KINDS, type ExportRow, type Import, type ImportKind, type PriceListLite } from '../server/types';
import { EXPORT_STATUS_LABEL, IMPORT_PERM, IMPORT_STATUS_LABEL, ImportNotice, KIND_LABEL, KIND_PERMS, failText } from './import-shared';
import { MasterTable, type Col } from './master-ui';
import { GatedButton, fmtDateTime, type Fail } from './shared';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HINT = 'Excel .xlsx only, up to 15 MB. Macro files (.xlsm) are not accepted.';
const POLL_MS = 2000;
const POLL_MAX_MS = 15 * 60_000;
const ALL = 'all';
const pending = (s: string) => s === 'queued' || s === 'building';
const kb = (n: number | undefined) => (n === undefined ? '—' : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ImportsScreen({ imports, exports: initialExports, priceLists, permissions }: {
  imports: readonly Import[];
  exports: readonly ExportRow[];
  priceLists: readonly PriceListLite[];
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const kinds = IMPORT_KINDS.filter((k) => KIND_PERMS[k].every((p) => permissions.includes(p)));
  const [kind, setKind] = useState<ImportKind | undefined>(kinds[0]);
  const [plId, setPlId] = useState<string>();
  const [file, setFile] = useState<File>();
  const key = useRef('');
  const inflight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [fail, setFail] = useState<Fail>();
  const [notReady, setNotReady] = useState(false);
  const [rows, setRows] = useState<readonly ExportRow[]>(initialExports);
  const [impKind, setImpKind] = useState(ALL);
  const [impStatus, setImpStatus] = useState(ALL);
  const [expKind, setExpKind] = useState(ALL);
  const [expStatus, setExpStatus] = useState(ALL);

  const pl = priceLists.find((p) => p.id === plId);
  const needsList = kind === 'price_list';
  const canUpload = !!kind && !!file && (!needsList || !!pl);

  const upload = async () => {
    if (inflight.current || !kind || !file || (needsList && !pl)) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      const form = new FormData();
      form.set('kind', kind);
      if (needsList) form.set('target_price_list_id', pl!.id);
      form.set('file', file, file.name);
      const r = await createImportAction(form, key.current);
      if (r.ok) {
        router.push(`/catalog/imports/${r.data.id}`); // stays locked (no second import of the same file) until another file is chosen
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

  const exportKind = kind === 'price_list' || kind === 'catalog_master' || kind === 'referrers' ? kind : undefined; // credit_parties has no export kind
  const exportMissing = kind === 'referrers' && !permissions.includes(IMPORT_PERM.referrerExport) ? [IMPORT_PERM.referrerExport] : [];
  const startExport = async () => {
    if (!exportKind || exporting) return;
    setExporting(true);
    setFail(undefined);
    try {
      const version = exportKind === 'price_list' ? pl?.current_version?.id : undefined;
      const r = await createExportAction({ kind: exportKind, ...(version ? { price_list_version_id: version } : {}) }, crypto.randomUUID());
      if (r.ok) {
        setRows((cur) => [r.data, ...cur.filter((x) => x.id !== r.data.id)]);
        toast.show({ tone: 'success', title: 'Export started. The file appears below when it is ready.' });
      } else setFail(r);
    } finally {
      setExporting(false);
    }
  };

  // F-16 step 2: poll queued/building exports every 2 s (one request at a time) until none is pending; stop after 15 min.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const anyPending = rows.some((r) => pending(r.status));
  useEffect(() => {
    if (!anyPending) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const tick = () => {
      timer = setTimeout(async () => {
        if (Date.now() - started >= POLL_MAX_MS) return;
        for (const id of rowsRef.current.filter((r) => pending(r.status)).map((r) => r.id)) {
          try {
            const r = await pollExportAction(id);
            if (alive && r.ok) {
              rowsRef.current = rowsRef.current.map((x) => (x.id === id ? r.data : x)); // synchronous, so the next tick sees `ready` before React re-renders
              setRows(rowsRef.current);
            }
          } catch {
            /* transient: the next tick retries */
          }
        }
        if (alive && rowsRef.current.some((r) => pending(r.status))) tick();
      }, POLL_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [anyPending]);

  const download = async (e: MouseEvent, r: ExportRow) => {
    e.preventDefault();
    setNotReady(false);
    setFail(undefined);
    try {
      const res = await fetch(`/catalog/exports/${r.id}/file`);
      if (res.status === 409) return setNotReady(true);
      if (!res.ok) return setFail({ ok: false, status: res.status, code: 'common.internal' });
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = r.file_name ?? 'export.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setFail({ ok: false, status: 0, code: 'common.internal' });
    }
  };

  const shownImports = imports.filter((i) => (impKind === ALL || i.kind === impKind) && (impStatus === ALL || i.status === impStatus));
  const importCols: Col<Import>[] = [
    { header: 'Started', cell: (r) => fmtDateTime(r.created_at) },
    { header: 'Kind', cell: (r) => KIND_LABEL[r.kind] ?? r.kind },
    { header: 'Target', cell: (r) => (r.target_price_list_id ? (priceLists.find((p) => p.id === r.target_price_list_id)?.code ?? '—') : '—') },
    { header: 'File name', cell: (r) => <a className="lims-link" href={`/catalog/imports/${r.id}`}>{r.file_name}</a> },
    { header: 'Status', cell: (r) => IMPORT_STATUS_LABEL[r.status] ?? r.status },
    { header: 'Errors / Warnings', cell: (r) => `${r.summary.errors} / ${r.summary.warnings}` },
    { header: 'By', cell: (r) => r.created_by.slice(0, 8) },
  ];
  const shownExports = rows.filter((r) => (expKind === ALL || r.kind === expKind) && (expStatus === ALL || r.status === expStatus));
  const exportCols: Col<ExportRow>[] = [
    { header: 'Kind', cell: (r) => KIND_LABEL[r.kind] ?? r.kind },
    { header: 'File name', cell: (r) => r.file_name ?? '—' },
    { header: 'Size', cell: (r) => kb(r.byte_size) },
    { header: 'Status', cell: (r) => EXPORT_STATUS_LABEL[r.status] ?? r.status },
    { header: 'Expires', cell: (r) => fmtDateTime(r.expires_at) || '—' },
    { header: 'Download', cell: (r) => (r.status === 'ready' ? <a className="lims-link" href={`/catalog/exports/${r.id}/file`} onClick={(e) => void download(e, r)}>Download</a> : '—') },
  ];
  const kindOptions = [{ value: ALL, label: 'All kinds' }, ...IMPORT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))];

  return (
    <section aria-label="Imports and exports">
      <PageHeader title="Imports & exports" helpKey="catalog.imports" breadcrumbs={[{ label: 'Pricing' }, { label: 'Imports & exports' }]} />
      {fail ? <ImportNotice tone={fail.code === 'auth.mfa_required' ? 'warning' : 'danger'} text={failText(fail)} /> : null}
      {notReady ? <Banner tone="info" title="Still preparing — try again shortly" /> : null}

      {kinds.length > 0 ? (
        <section aria-labelledby="imp-new" className="lims-stack">
          <h2 id="imp-new">Import</h2>
          <RadioGroup<ImportKind>
            label="What do you want to import?"
            name="kind"
            value={kind as ImportKind}
            onChange={(k) => { setKind(k); setFail(undefined); }}
            options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          />
          {needsList ? (
            <Select<string>
              label="Price list"
              name="target_price_list_id"
              value={plId as string}
              onChange={setPlId}
              placeholder="Choose a price list"
              options={priceLists.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))}
            />
          ) : null}
          <div className="lims-inline catalog-gap-3">
            {kind ? <a className="lims-link" href={`/catalog/import-templates/${kind}`}>Download blank template</a> : null}
            {exportKind ? (
              <GatedButton missing={exportMissing} variant="secondary" isLoading={exporting} isDisabled={needsList && !pl} onPress={() => void startExport()}>Download current data</GatedButton>
            ) : null}
          </div>
          <FileUpload
            label="File"
            name="file"
            accept={[XLSX]}
            description={HINT}
            onSelect={(f) => { setFile(f[0]); key.current = crypto.randomUUID(); setFail(undefined); inflight.current = false; setBusy(false); }}
          />
          <div>
            <Button variant="primary" isLoading={busy} isDisabled={!canUpload} onPress={() => void upload()}>Upload</Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="imp-hist" className="lims-stack">
        <h2 id="imp-hist">Import history</h2>
        <div className="lims-filter-bar">
          <Select<string> label="Kind" name="imp_kind" value={impKind} onChange={setImpKind} options={kindOptions} />
          <Select<string> label="Status" name="imp_status" value={impStatus} onChange={setImpStatus} options={[{ value: ALL, label: 'All statuses' }, ...IMPORT_STATUSES.map((s) => ({ value: s, label: IMPORT_STATUS_LABEL[s] }))]} />
        </div>
        <MasterTable caption="Import history" cols={importCols} rows={shownImports} empty={imports.length === 0 ? 'No imports yet.' : 'No imports match the filters.'} />
      </section>

      <section aria-labelledby="exp-hist" className="lims-stack">
        <h2 id="exp-hist">Exports</h2>
        <div className="lims-filter-bar">
          <Select<string> label="Export kind" name="exp_kind" value={expKind} onChange={setExpKind} options={kindOptions.filter((o) => o.value !== 'credit_parties')} />
          <Select<string> label="Export status" name="exp_status" value={expStatus} onChange={setExpStatus} options={[{ value: ALL, label: 'All statuses' }, ...EXPORT_STATUSES.map((s) => ({ value: s, label: EXPORT_STATUS_LABEL[s] ?? s }))]} />
        </div>
        <MasterTable caption="Exports" cols={exportCols} rows={shownExports} empty={rows.length === 0 ? 'No exports yet.' : 'No exports match the filters.'} />
      </section>
    </section>
  );
}
