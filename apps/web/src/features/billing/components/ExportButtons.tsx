'use client';
// B28 export request + 2 s status polling through the BFF + B29a download (04-UI-UX §1 live updates, §8.7). Only rendered with billing.data.export.
// The download link is a same-origin BFF route: no storage URL is ever shown or copyable.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { useToast } from '@lims/ui/components/Toast';
import { createExportAction, getExportAction } from '../server/actions';
import type { ExportFormat, ExportKind } from '../server/types';
import { errorText } from './format';

const POLL_MS = 2000;
const LABEL: Record<ExportFormat, string> = { xlsx: 'Excel', xml: 'XML', pdf: 'PDF' };

export function ExportButtons({ kind, formats, filters = {} }: { kind: ExportKind; formats: readonly ExportFormat[]; filters?: { fiscal_year_bs?: string; from?: string; to?: string; centre_id?: string } }) {
  const toast = useToast();
  const [job, setJob] = useState<{ id: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed' || job.status === 'expired') return;
    const t = setInterval(async () => {
      const r = await getExportAction(job.id);
      if (r.ok) setJob(r.data);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [job]);

  const start = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await createExportAction(kind, format, filters, key.current);
      if (r.ok) { setJob(r.data); key.current = crypto.randomUUID(); } else toast.show({ tone: 'danger', title: 'Could not start the export', description: errorText(r.code) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lims-export-buttons">
      {formats.map((f) => <Button key={f} isDisabled={busy} onPress={() => void start(f)}>{formats.length === 1 ? 'Export' : LABEL[f]}</Button>)}
      {job ? (
        <span role="status">
          {job.status === 'ready' ? <a className="lims-link" href={`/billing/exports/${job.id}/content`}>Download</a> : job.status === 'failed' ? 'Export failed. Try again.' : job.status === 'expired' ? 'Export expired. Start a new one.' : 'Preparing export…'}
        </span>
      ) : null}
    </div>
  );
}
