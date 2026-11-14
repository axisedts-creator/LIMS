'use client';
// 04-UI-UX §3.4 report drawer "Preliminary report" / "Final report" (Drawer width=lg) — AC-09.1/09.2/09.3/09.6, AC-10.1/10.3/10.4/10.5, AC-11.2/11.3/11.6 (UI side).
// LD-140 (2026-11-13): kit components only (no hex colours, pixel radii or inline style objects); one primary button (Send for verification); every status shows tone, icon and word.
// The UI never decides report state: it posts, C10 builds the snapshot, talks to C5 and answers; on success the page refreshes. An amendment is never sent from here (AC-09.6, AC-11.2):
// C10 derives it from the culture / C5 state. Disabled-state explanation for an approved preliminary: 08 A17 D-61 (the pre-check is only a hint, the API re-checks).
// The Idempotency-Key is created per drawer opening and is reused on a retry of the unchanged form (AC-09.3); a changed form gets a new key. Free text is posted verbatim and shown as text (REQ-SEC-088).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { toOptions } from '../../forms/format';
import { useLoad } from '../settings/useLoad';
import { alertOrganismsAction, earlyFinalRequiresReasonAction, listOutcomesAction, submitReportAction } from '../../server/reportActions';
import type { CultureDetailDto, ReportPhase, ReportSubmitInput } from '../../server/types';
import { newKey, type Fail } from '../common';
import { ReportNotice } from './ReportNotice';
import { AstTable, IsolatesTable, type AstRow, type IsolateRow } from './SnapshotTables';
import { SUMMARY_MAX, approvedBlocked, blockedText, generateSummary, includedIsolates, isEarlyFinal } from './snapshot';

export const REPORT_TITLE: Record<ReportPhase, string> = { preliminary: 'Preliminary report', final: 'Final report' };

export function ReportDrawer({ culture, phase, onClose, onSent }: { culture: CultureDetailDto; phase: ReportPhase; onClose: () => void; onSent: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const noteId = useId();
  const included = useMemo(() => includedIsolates(culture), [culture]);
  const outcomes = useLoad(() => listOutcomesAction(), 'culture_outcomes', phase === 'final');
  const [outcome, setOutcome] = useState<string>();
  const [summary, setSummary] = useState(() => generateSummary(culture, phase, undefined));
  const [comments, setComments] = useState('');
  const [critical, setCritical] = useState(false);
  const [early, setEarly] = useState('');
  const [earlyRequired, setEarlyRequired] = useState(true); // settings.early_final_requires_reason; the stricter reading until it is known
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Fail>();
  const edited = useRef(false); // the user typed in Summary: an outcome change no longer rewrites it
  const criticalTouched = useRef(false);
  const key = useRef(newKey());
  const inflight = useRef(false);
  const blocked = approvedBlocked(culture);
  const early_ = isEarlyFinal(culture, phase, outcome);

  // "a changed form is a new request": a new Idempotency-Key; a retry of the unchanged form re-sends the same one (AC-09.3).
  const touch = () => {
    key.current = newKey();
    setFail(undefined);
  };

  useEffect(() => {
    if (phase !== 'final') return;
    let alive = true;
    earlyFinalRequiresReasonAction().then(
      (r) => { if (alive && r.ok) setEarlyRequired(r.data.required); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [phase]);

  // Notify as critical: pre-ticked when an alert organism (is_alert) is among the included isolates (TRD §4.6); a failed read leaves it unticked.
  useEffect(() => {
    const list = included.filter((i) => i.isolate.organism_code && i.isolate.organism_display).map((i) => ({ code: i.isolate.organism_code!, display: i.isolate.organism_display! }));
    if (list.length === 0) return;
    let alive = true;
    alertOrganismsAction(list).then(
      (r) => { if (alive && r.ok && r.data.length > 0 && !criticalTouched.current) setCritical(true); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [included]);

  // The submit button is described by the disabled-state explanation (kit Button has no aria-describedby prop; set on the element when it mounts).
  const describe = useCallback(
    (el: HTMLButtonElement | null) => {
      if (!el) return;
      if (blocked) el.setAttribute('aria-describedby', noteId);
      else el.removeAttribute('aria-describedby');
    },
    [blocked, noteId],
  );

  const outcomeDisplay = (code: string | undefined) => outcomes.rows.find((o) => o.code === code)?.display;
  const regenerate = (code: string | undefined = outcome) => setSummary(generateSummary(culture, phase, outcomeDisplay(code)));

  const submit = async () => {
    if (blocked || inflight.current) return; // Ctrl+Enter reaches here even when the button is disabled
    if (phase === 'final' && !outcome) return;
    const body: ReportSubmitInput = {
      report_phase: phase,
      ...(phase === 'final' ? { outcome_code: outcome! } : {}),
      is_critical: critical,
      culture_summary_text: summary,
      ...(comments.trim() ? { comments_text: comments } : {}),
      ...(early_ && early.trim() ? { early_final_reason: early } : {}),
    };
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      const r = await submitReportAction(culture.id, body, key.current);
      if (!r.ok) {
        setFail(r);
        return;
      }
      toast.show({ tone: 'success', title: r.data?.version_no ? `Report version ${r.data.version_no} sent for verification` : 'Report sent for verification' });
      router.refresh();
      onClose();
      onSent();
    } catch {
      setFail({ ok: false, status: 0, code: 'common.internal' });
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const isolateRows: IsolateRow[] = included.map(({ isolate: i }) => ({ seq: i.isolate_seq, organism: i.organism_display ?? i.organism_code ?? '', growth: i.quantity_text }));
  const astRows: AstRow[] = included.flatMap(({ isolate: i, rows }) =>
    rows.map((r) => ({ isolate_seq: i.isolate_seq, antibiotic_code: r.antibiotic_code, antibiotic: r.antibiotic_display, method: r.method, raw: r.raw_value, category: r.category_code, standard: r.standard, version: r.standard_version })),
  );

  return (
    <Drawer title={REPORT_TITLE[phase]} isOpen onClose={onClose} width="lg">
      <Form onSubmit={submit} {...(fail?.errors ? { problem: { errors: fail.errors } } : {})}>
        <Stack gap={3}>
          <ReportNotice fail={fail} />
          {blocked ? (
            <div id={noteId} role="note">
              <Banner tone="info" title={blockedText(phase)} />
            </div>
          ) : null}
          {culture.status === 'amending' ? <DescriptionList items={[{ term: 'Amendment reason', value: culture.amendment_reason_text ?? '—' }]} /> : null}
          {phase === 'final' ? (
            <CodedSelect
              label="Outcome"
              name="outcome_code"
              codedSet="micro.culture_outcomes"
              placeholder="Outcome…"
              isRequired
              options={toOptions(outcomes.rows)}
              {...(outcome ? { value: outcome } : {})}
              onChange={(c) => {
                setOutcome(c);
                if (!edited.current) regenerate(c);
                touch();
              }}
            />
          ) : null}
          <h3 className="lims-drawer-section-title">Included isolates</h3>
          <IsolatesTable rows={isolateRows} />
          <h3 className="lims-drawer-section-title">Included AST results</h3>
          <AstTable rows={astRows} />
          <TextArea
            label="Summary"
            name="culture_summary_text"
            isRequired
            maxLength={SUMMARY_MAX}
            rows={6}
            value={summary}
            onChange={(v) => {
              edited.current = true;
              setSummary(v);
              touch();
            }}
          />
          <Inline gap={2}>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                edited.current = false;
                regenerate();
                touch();
              }}
            >
              Regenerate
            </Button>
          </Inline>
          <TextArea label="Comments" name="comments_text" maxLength={4000} rows={3} value={comments} onChange={(v) => { setComments(v); touch(); }} />
          {early_ ? <TextArea label="Reason for early final" name="early_final_reason" maxLength={500} rows={3} isRequired={earlyRequired} value={early} onChange={(v) => { setEarly(v); touch(); }} /> : null}
          <Checkbox
            label="Notify as critical"
            name="is_critical"
            isSelected={critical}
            onChange={(v) => {
              criticalTouched.current = true;
              setCritical(v);
              touch();
            }}
          />
          <Inline gap={2}>
            <Button ref={describe} type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy} isDisabled={blocked}>
              Send for verification
            </Button>
            <Button variant="ghost" onPress={onClose} isDisabled={busy}>
              Cancel
            </Button>
          </Inline>
        </Stack>
      </Form>
    </Drawer>
  );
}
