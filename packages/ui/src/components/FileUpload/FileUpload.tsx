// 04-UI-UX §2.2 FileUpload. Client checks are hints only (REQ-SEC-083; the server re-checks type, size and scan).
// Files are never previewed or read on the app origin (REQ-SEC-085): only name/type/size are touched.
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { uploadQueue, type SendControl, type UploadState } from './uploadQueue';
import { useFormField } from '../Form/FormContext';
import type { FieldBase } from '../_shared/TextInputBase';

export type UploadType =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'text/csv'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type ScanState = 'pending' | 'clean' | 'infected' | 'unavailable';

export interface FileUploadProps extends FieldBase {
  /** ⊆ the operation's x-upload list (08 §4.13). The declared MIME type decides, not the extension. */
  accept: readonly UploadType[];
  /** Default 15 MB (CV §10.2). */
  maxBytes?: number;
  multiple?: boolean;
  maxFiles?: number;
  onSelect: (files: readonly File[]) => void;
  /** Percent per file, keyed by file name. */
  progress?: Readonly<Record<string, number>>;
  /** Virus-scan state per file, keyed by file name. */
  scanState?: Readonly<Record<string, ScanState>>;
  /** T0B-FILES-1 (LD-310): the host's direct-to-storage transport. When set, the kit queues uploads (3 in parallel), shows progress,
   * cancel and retry (3 retries with backoff). The kit never reads file bytes itself (REQ-SEC-085). */
  uploadFile?: (file: File, c: SendControl) => Promise<void>;
  /** Wait before retry n (1-based). Default 250 ms doubling, capped at 30 s. */
  retryDelayMs?: (retry: number) => number;
  onUploaded?: (file: File) => void;
  onUploadFailed?: (file: File) => void;
}

const MAX_RETRIES = 3;
const STATUS_TEXT = (s: UploadState): string =>
  s.status === 'queued' ? 'Waiting' : s.status === 'uploading' ? 'Uploading' : s.status === 'retrying' ? `Retrying (${s.attempt} of ${MAX_RETRIES})`
    : s.status === 'done' ? 'Uploaded' : s.status === 'failed' ? 'Upload failed' : 'Cancelled';

const MB = 1024 * 1024;
const SCAN_TEXT: Record<ScanState, string> = { pending: 'Scanning for viruses', clean: 'Clean', infected: 'Infected: this file was blocked', unavailable: 'Virus scan unavailable' };
const mb = (n: number) => `${Math.round((n / MB) * 10) / 10} MB`;
const text = {
  type: (n: string) => `${n}: this file type is not allowed`,
  size: (n: string, max: number) => `${n} is larger than ${mb(max)}`,
  empty: (n: string) => `${n} is empty`,
  count: (max: number) => `Choose at most ${max} ${max === 1 ? 'file' : 'files'}`,
};

export function FileUpload({ label, name, description, error: ownError, isRequired, isDisabled, isReadOnly, accept, maxBytes = 15 * MB, multiple, maxFiles, onSelect, progress, scanState, uploadFile, retryDelayMs, onUploaded, onUploadFailed, ...rest }: FileUploadProps) {
  const id = useId();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const error = useFormField(name, { validate: () => (isRequired && files.length === 0 ? `Enter ${label}` : undefined), focus: () => document.getElementById(id)?.focus() }, ownError);
  const limit = multiple ? (maxFiles ?? Infinity) : 1;
  const locked = isDisabled || isReadOnly;
  const [rows, setRows] = useState<Readonly<Record<number, UploadState>>>({});
  /** Row index -> the queue that owns it and the row's index inside that queue. */
  const owners = useRef(new Map<number, { cancel(i: number): void; at: number }>());
  const cancelAll = () => { for (const [, q] of owners.current) q.cancel(q.at); owners.current.clear(); };
  useEffect(() => cancelAll, []);

  const start = (list: readonly File[], at: readonly number[]) => {
    if (!uploadFile) return;
    let q: ReturnType<typeof uploadQueue> | undefined;
    const owner = { cancel: (k: number) => q?.cancel(k), at: 0 };
    at.forEach((row, i) => owners.current.set(row, { cancel: owner.cancel, at: i }));
    const mine = (row: number) => owners.current.get(row)?.cancel === owner.cancel;
    q = uploadQueue({
      files: list, send: uploadFile, maxRetries: MAX_RETRIES, ...(retryDelayMs ? { backoffMs: retryDelayMs } : {}),
      onState: (_n, s, i) => {
        const row = at[i]!;
        if (!mine(row)) return;   // a newer pick or a Try again owns this row now
        setRows((r) => ({ ...r, [row]: s }));
        if (s.status === 'done') onUploaded?.(list[i]!);
        else if (s.status === 'failed') onUploadFailed?.(list[i]!);
      },
    });
  };

  const take = (list: FileList | readonly File[] | null | undefined) => {
    if (locked || !list) return;
    const all = Array.from(list);
    if (all.length === 0) return;
    if (all.length > limit) {
      setProblems([text.count(limit)]);
      return;
    }
    const bad: string[] = [];
    const ok = all.filter((f) => {
      const why = !(accept as readonly string[]).includes(f.type) ? text.type(f.name) : f.size === 0 ? text.empty(f.name) : f.size > maxBytes ? text.size(f.name, maxBytes) : undefined;
      if (why) bad.push(why);
      return !why;
    });
    setProblems(bad);
    if (ok.length) {
      cancelAll();
      setRows({});
      setFiles(ok);
      onSelect(ok);
      start(ok, ok.map((_, i) => i));
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    take(e.dataTransfer?.files);
  };
  const ids = { desc: `${id}-d`, err: `${id}-e`, prob: `${id}-p` };
  const describedBy = [description && ids.desc, error && ids.err, problems.length && ids.prob].filter(Boolean).join(' ');

  return (
    <div className="lims-field lims-file-upload" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}>
      <label className="lims-label" htmlFor={id}>
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        type="file"
        className="lims-file-input"
        name={name}
        accept={accept.join(',')}
        multiple={!!multiple}
        disabled={locked}
        required={isRequired}
        aria-invalid={error ? true : undefined}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        onChange={(e) => {
          take(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
        onDrop={(e) => {
          e.stopPropagation();
          onDrop(e);
        }}
      />
      {description ? (
        <p id={ids.desc} className="lims-description">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={ids.err} className="lims-error">
          {error}
        </p>
      ) : null}
      <div id={ids.prob} aria-live="polite">
        {problems.length ? (
          <ul className="lims-error lims-file-problems">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {files.length ? (
        <ul className="lims-file-list">
          {files.map((f, i) => {
            const up = uploadFile ? (rows[i] ?? { status: 'queued', percent: 0, attempt: 0 }) : undefined;
            const pct = up ? up.percent : progress?.[f.name];
            const scan = scanState?.[f.name];
            const active = up && (up.status === 'queued' || up.status === 'uploading' || up.status === 'retrying');
            const ended = up && (up.status === 'failed' || up.status === 'cancelled');
            return (
              <li key={`${i}-${f.name}`} className="lims-file-item">
                <span className="lims-file-name">{f.name}</span>
                {pct !== undefined ? (
                  <span role="progressbar" aria-label={`Upload progress for ${f.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, pct))} className="lims-progress">
                    {Math.round(Math.max(0, Math.min(100, pct)))}%
                  </span>
                ) : null}
                {up ? (
                  <span className={`lims-file-status lims-upload-${up.status}`} {...(up.status === 'failed' ? { role: 'alert' } : { 'aria-live': 'polite' as const })}>
                    {STATUS_TEXT(up)}
                  </span>
                ) : null}
                {active ? (
                  <button type="button" className="lims-file-action" aria-label={`Cancel upload of ${f.name}`} onClick={() => owners.current.get(i)?.cancel(owners.current.get(i)!.at)}>
                    Cancel
                  </button>
                ) : null}
                {ended ? (
                  <button type="button" className="lims-file-action" aria-label={`Try again with ${f.name}`} onClick={() => start([f], [i])}>
                    Try again
                  </button>
                ) : null}
                {scan ? (
                  <span className={`lims-file-scan lims-scan-${scan}`} {...(scan === 'infected' ? { role: 'alert' } : {})}>
                    {SCAN_TEXT[scan]}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
