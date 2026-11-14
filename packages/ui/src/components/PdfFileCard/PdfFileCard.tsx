import { Button } from '../Button/Button';
import type { Tone } from '../_shared/messages';

/** C6 04-UI-UX:325. State copy (C6 :115-121) and tone are the caller's. */
export interface PdfFileCardProps {
  filename: string;
  sizeBytes: number;
  pageCount?: number;
  state: string;
  stateLabel: string;
  tone: Tone;
  onDownload?: () => void;
  'data-testid'?: string;
}

function size(n: number) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Uploaded PDF summary (C6 input files). */
export function PdfFileCard({ filename, sizeBytes, pageCount, state, stateLabel, tone, onDownload, ...rest }: PdfFileCardProps) {
  return (
    <div className="lims-card lims-filecard" data-state={state} {...rest}>
      <p className="lims-filecard-name">{filename}</p>
      <p className="lims-description">
        {size(sizeBytes)}
        {pageCount !== undefined && Number.isFinite(pageCount) ? ` · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : ''}
      </p>{' '}
      <p role="status" className={`lims-filecard-state lims-tone-${tone}`} data-tone={tone}>
        {stateLabel}
      </p>
      {onDownload ? (
        <div className="lims-filecard-actions">
          <Button size="sm" onPress={onDownload}>
            Download
          </Button>
        </div>
      ) : null}
    </div>
  );
}
