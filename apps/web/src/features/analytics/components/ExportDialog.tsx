'use client';
// 04-UI-UX §6 export dialog (US-17.1; US-02.1 UI side). Posts through a server action -> BFF; `params` are sent verbatim
// (bs_month / fiscal_year_bs / dates stay as given, no client-side B.S.<->A.D. conversion). One Idempotency-Key per
// (format) attempt: a retry after a failure re-sends the same key, a changed body gets a new one.
import { useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Inline } from '@lims/ui/components/Inline';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { useToast } from '@lims/ui/components/Toast';
import { createExportAction } from '../server/actions';

type Format = 'xlsx' | 'csv' | 'pdf';
type Fail = 'limit' | 'mfa' | 'range' | 'forbidden' | 'other';

export interface ExportSummary { report: string; periodAd: string; periodBs: string; centres: readonly string[]; groupBy?: string }

const BANNER: Record<Fail, { tone: 'warning' | 'danger'; title: string }> = {
  limit: { tone: 'warning', title: 'Export limit reached. Try again at a later time.' }, // ponytail: API gives no retry time through the action; add when 429 carries one
  mfa: { tone: 'warning', title: 'Verify with your authenticator app to export this report.' },
  range: { tone: 'danger', title: 'Choose 366 days or fewer.' },
  forbidden: { tone: 'danger', title: 'You no longer have access to this data.' },
  other: { tone: 'danger', title: 'Export failed. Try again.' },
};

const failOf = (status: number, code: string): Fail =>
  code === 'common.rate_limited' || status === 429 ? 'limit'
  : code === 'auth.mfa_required' ? 'mfa'
  : code === 'analytics.range_too_large' ? 'range'
  : status === 403 ? 'forbidden'
  : 'other';

export function ExportDialog({ isOpen, onClose, reportCode, params, summary, pdfEnabled = false, onVerify, initialFormat = 'xlsx' }: {
  isOpen: boolean;
  onClose: () => void;
  /** Preselected format (the report page's Export menu choice). */
  initialFormat?: Format;
  reportCode: string;
  params: Record<string, unknown>;
  summary: ExportSummary;
  pdfEnabled?: boolean;
  onVerify?: () => void;
}) {
  const toast = useToast();
  const [format, setFormat] = useState<Format>(initialFormat);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Fail>();
  const inflight = useRef(false);
  const attempt = useRef<{ format: Format; key: string }>(null);

  const submit = async () => {
    if (inflight.current || !ack) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    if (attempt.current?.format !== format) attempt.current = { format, key: crypto.randomUUID() };
    try {
      const r = await createExportAction(reportCode, format, params, attempt.current.key);
      if (r.ok) {
        attempt.current = null;
        toast.show({ tone: 'success', title: 'Export queued', description: 'You can download it from My exports.' });
        onClose();
      } else setFail(failOf(r.status, r.code));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const b = fail ? BANNER[fail] : undefined;
  return (
    <Dialog title="Export report" isOpen={isOpen} onClose={onClose} size="sm">
      {b ? <Banner tone={b.tone} title={b.title} {...(fail === 'mfa' ? { action: { label: 'Verify now', onPress: onVerify ?? (() => window.location.reload()) } } : {}) /* ponytail: no C2 step-up route known; caller passes onVerify, default reloads so the session guard can redirect */} /> : null}
      <RadioGroup<Format>
        label="Format"
        name="format"
        value={format}
        onChange={setFormat}
        options={[{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }, { value: 'pdf', label: 'PDF', ...(pdfEnabled ? {} : { isDisabled: true }) }] /* LD-83: kit RadioGroup per-option isDisabled */}
        {...(pdfEnabled ? {} : { description: 'PDF export is not available yet' })}
      />
      <DescriptionList
        items={[
          { term: 'Report', value: summary.report },
          { term: 'Period (A.D.)', value: summary.periodAd },
          { term: 'Period (B.S.)', value: summary.periodBs },
          { term: 'Centres', value: summary.centres.length ? summary.centres.join(', ') : 'All centres' },
          ...(summary.groupBy ? [{ term: 'Group by', value: summary.groupBy }] : []),
        ]}
      />
      <Checkbox label="I will keep this file inside the lab and delete it when no longer needed." isSelected={ack} onChange={setAck} />
      {/* LD-140: kit Inline instead of an inline style object */}
      <Inline gap={2} justify="end">
        <Button variant="ghost" onPress={onClose}>Cancel</Button>
        <Button variant="primary" isDisabled={!ack} isLoading={busy} onPress={() => void submit()}>Export</Button>
      </Inline>
    </Dialog>
  );
}
