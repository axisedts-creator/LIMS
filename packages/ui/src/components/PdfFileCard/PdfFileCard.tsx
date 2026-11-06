import type { ReactNode } from 'react';
import type { Tone } from '../_shared/messages';
import { formatDateTime } from '../_shared/time';

export type PdfFileState = 'pending_scan' | 'scanning' | 'sanitizing' | 'ready' | 'quarantined' | 'rejected' | 'confirmed';
export type PdfRejectReason = 'encrypted' | 'damaged' | 'too_many_pages' | 'timed_out';

/** C6 04-UI-UX:120 reason words. */
const REASON: Record<PdfRejectReason, string> = { encrypted: 'encrypted', damaged: 'damaged', too_many_pages: 'too many pages', timed_out: 'took too long' };

export interface PdfFileCardProps {
  fileName: string;
  sizeBytes: number;
  pageCount?: number;
  state: PdfFileState;
  rejectReason?: PdfRejectReason;
  confirmedBy?: string;
  /** IsoUtc. */
  confirmedAt?: string;
  /** Open/confirm actions; rendered only for ready/confirmed files (never for blocked ones). */
  actions?: ReactNode;
  'data-testid'?: string;
}

function size(n: number) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Copy verbatim from C6 04-UI-UX:115-122. */
function stateOf(p: PdfFileCardProps): [Tone, string] {
  switch (p.state) {
    case 'pending_scan':
    case 'scanning':
      return ['info', 'Checking the file for viruses…'];
    case 'sanitizing':
      return ['info', 'Preparing the file…'];
    case 'ready':
      return ['warning', 'Ready. Open it and confirm it belongs to this patient.'];
    case 'quarantined':
      return ['danger', 'This file was blocked by the virus scanner and has been isolated.'];
    case 'rejected':
      return ['danger', `This PDF could not be used${p.rejectReason && Object.hasOwn(REASON, p.rejectReason) ? ` (${REASON[p.rejectReason]})` : ''}.`];
    case 'confirmed':
      return ['success', `Confirmed by ${p.confirmedBy ?? '—'} at ${formatDateTime(p.confirmedAt)}.`];
    default:
      return ['neutral', String(p.state)];
  }
}

/** Uploaded PDF summary (C6 input files). */
export function PdfFileCard(p: PdfFileCardProps) {
  const [tone, text] = stateOf(p);
  const openable = p.state === 'ready' || p.state === 'confirmed';
  return (
    <div className="lims-card lims-filecard" {...(p['data-testid'] ? { 'data-testid': p['data-testid'] } : {})}>
      <p className="lims-filecard-name">{p.fileName}</p>
      <p className="lims-description">
        {size(p.sizeBytes)}
        {p.pageCount !== undefined && Number.isFinite(p.pageCount) ? ` · ${p.pageCount} ${p.pageCount === 1 ? 'page' : 'pages'}` : ''}
      </p>{' '}
      <p role="status" className={`lims-filecard-state lims-tone-${tone}`} data-tone={tone}>
        {text}
      </p>
      {openable && p.actions ? <div className="lims-filecard-actions">{p.actions}</div> : null}
    </div>
  );
}
