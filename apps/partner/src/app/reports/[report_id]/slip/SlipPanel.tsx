'use client';
// PR-2 slip panel (04-UI-UX PR-2): R4 once on mount (Idempotency-Key per visit), then R5 every 1 s for at most 30 s (pollAccessSlip, 08 A5.3).
// Screens use only @lims/ui components (LD-140). The browser handles ids and states only: the PDF comes from the R6 route .../access-slips/{id}/file (BFF), the link exists only inside the PDF (08 A2.1).
// D-105: the no-mobile warning shows before and after the request; the request is always allowed. [CONV] the partner API returns no phone flag, so the warning is always shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DateText } from '@lims/ui/components/DateText';
import { Spinner } from '@lims/ui/components/Spinner';
import { pollAccessSlip } from '@/core/slip-poll';
import { readSlip, requestSlip, type SlipView } from './actions';

type Phase = { kind: 'working' } | { kind: 'timeout'; slip: SlipView } | { kind: 'done'; slip: SlipView } | { kind: 'error' };
const NO_PHONE = 'The slip opens only if the lab has a mobile number for this patient.';

export function SlipPanel({ reportId }: { reportId: string }) {
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });

  const poll = useCallback(async (first: SlipView) => {
    setPhase({ kind: 'working' });
    try {
      const { slip, timedOut } = await pollAccessSlip<SlipView>(async () => {
        const r = await readSlip(reportId, first.id);
        if (!r.ok) throw new Error(r.code);
        return r.slip;
      });
      setPhase(timedOut ? { kind: 'timeout', slip } : { kind: 'done', slip });
    } catch {
      setPhase({ kind: 'error' });
    }
  }, [reportId]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    requestSlip(reportId, crypto.randomUUID()).then(
      (r) => (r.ok ? poll(r.slip) : setPhase({ kind: 'error' })),
      () => setPhase({ kind: 'error' }),
    );
  }, [reportId, poll]);

  return (
    <div>
      <h1>Patient slip</h1>
      <Banner tone="warning" title={NO_PHONE} data-testid="partners.slip.no_phone_warning" />
      {phase.kind === 'working' ? <Spinner label="Preparing the slip…" /> : null}
      {phase.kind === 'working' ? <p>Preparing the slip…</p> : null}
      {phase.kind === 'timeout' ? (
        <Banner tone="info" title="The slip is taking longer than usual. Check again in a minute.">
          <Button onPress={() => void poll(phase.slip)}>Check again</Button>
        </Banner>
      ) : null}
      {phase.kind === 'error' ? <Banner tone="danger" title="A slip cannot be made for this report." /> : null}
      {phase.kind === 'done' && phase.slip.state === 'issued' ? (
        <div>
          <Button variant="primary" iconStart="arrow-down" onPress={() => window.location.assign(`/reports/${reportId}/slip/${phase.slip.id}/file`)}>Download slip (PDF)</Button>
          {phase.slip.link_expires_at ? <p>Link valid until <DateText value={phase.slip.link_expires_at as Parameters<typeof DateText>[0]['value']} withTime /></p> : null}
        </div>
      ) : null}
      {phase.kind === 'done' && phase.slip.state === 'failed' ? (
        <Banner tone="danger" title="A slip cannot be made for this report.">
          {phase.slip.failure_code === 'reporting.report_superseded' ? 'This report has a newer version. Make the slip from the latest version.' : null}
        </Banner>
      ) : null}
      {phase.kind === 'done' && phase.slip.state === 'expired' ? <Banner tone="neutral" title="This slip has expired." /> : null /* LD-140: tone + icon + word */}
    </div>
  );
}
