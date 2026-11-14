'use client';
// SCR label page /lab/orders/{order_id}/labels (PRD AC-02.1/02.2/02.5; 03-APP-FLOW §3.1; 04-UI-UX §3.1; 08 A13 D-4). Needs only two calls: #14a readiness (polled every 1 s up to
// `waitSeconds` = LIMS_LAB_LABEL_WAIT_SECONDS, read by the server page) and #14 for the ready specimens (default copies); then window.print() once, after the labels are in the DOM.
// A reprint (untick, choose copies, "Print labels") calls #14 again and is counted again on the server. Labels come only from the #14 response; the print CSS is sized from it.
// Not built here: "Mark selected collected" (bulkCollectSpecimens) — outside this task's two operations; see .orchestra/notes/C5.T-10-impl.md.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { useToast } from '@lims/ui/components/Toast';
import { printSpecimenLabels, requestOrderLabelPrint } from '../../server/printSpecimenLabels.server';
import type { ActionResult } from '../../server/types';
import { Failure } from '../shared';
import { TOO_SMALL, barcodeFits, htmlSvgRenderer } from './LabelRenderer';
import { toLabelData, type OrderLabelPrintResponse, type PrintLabelsResponse, type ReadySpecimen } from './labelTypes';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;
type Phase = 'preparing' | 'timeout' | 'ready' | 'fail' | 'encode';
interface Job { id: number; n: number }

const POLL_MS = 1000;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clampCopies = (n: number) => (Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1);
export const NOT_READY = 'Labels are not ready yet. Try again in a moment.';
export const ENCODE_ERROR = "These labels can't be printed: a barcode value can't be encoded as Code 128. Nothing was sent to the printer.";

export function LabelPage({ orderId, waitSeconds = 15 }: { orderId: string; waitSeconds?: number; permissions?: readonly string[] }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('preparing');
  const [fail, setFail] = useState<Fail | null>(null);
  const [specimens, setSpecimens] = useState<ReadySpecimen[]>([]);
  const [inactive, setInactive] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [copies, setCopies] = useState(1);
  const [meta, setMeta] = useState<{ registrationNo: string; patientName: string } | null>(null);
  const [html, setHtml] = useState('');
  const [tooSmall, setTooSmall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reprintFail, setReprintFail] = useState<Fail | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [tick, setTick] = useState(0);
  const jobSeq = useRef(0);
  const printed = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  /** Render a #14 answer. A renderer error (barcode that cannot be encoded) stops everything: no print dialog, no guess. Returns false then. */
  const apply = useCallback((p: PrintLabelsResponse, initial: boolean): boolean => {
    const bad = new Set(p.errors.filter((e) => e.code === 'lab.specimen_inactive').map((e) => e.id));
    setInactive((s) => new Set([...s, ...bad]));
    if (initial) setCopies(clampCopies(p.label_copies_default));   // a reprint keeps the user's choice
    const first = p.labels[0];
    if (first) setMeta({ registrationNo: first.registration_no, patientName: first.patient_name });
    let out = '';
    try {
      out = htmlSvgRenderer.render(p.labels.map(toLabelData), { widthMm: p.size.width_mm, heightMm: p.size.height_mm });
    } catch {
      setPhase('encode');
      return false;
    }
    const small = p.labels.some((l) => !barcodeFits(l.barcode, p.size.width_mm));
    setHtml(out);
    setTooSmall(small);
    setPhase('ready');
    const n = p.labels.reduce((a, l) => a + clampCopies(l.copies), 0);
    if (n > 0 && !small) setJob({ id: ++jobSeq.current, n });
    return true;
  }, []);

  useEffect(() => {
    let live = true;
    const start = Date.now();
    setPhase('preparing'); setFail(null); setReprintFail(null); setHtml(''); setJob(null); setTooSmall(false);
    void (async () => {
      let ready: OrderLabelPrintResponse;
      for (;;) {
        const r = await requestOrderLabelPrint(orderId);
        if (!live) return;
        if (r.ok) { ready = r.data; break; }
        if (r.status === 409 && r.code === 'common.version_conflict') {
          if (Date.now() - start + POLL_MS > waitSeconds * 1000) { setPhase('timeout'); return; }
          await wait(POLL_MS);
          if (!live) return;
          continue;
        }
        setFail(r); setPhase('fail');
        return;
      }
      setSpecimens(ready.specimens);
      setInactive(new Set(ready.specimens.filter((s) => s.outcome !== 'ready').map((s) => s.specimen_id)));
      const ids = ready.specimens.filter((s) => s.outcome === 'ready').map((s) => s.specimen_id);
      setSelected(new Set(ids));
      if (ids.length === 0) { setPhase('ready'); return; }
      const p = await printSpecimenLabels({ specimenIds: ids });
      if (!live) return;
      if (!p.ok) { setFail(p); setPhase('fail'); return; }
      apply(p.data, true);
    })();
    return () => { live = false; };
  }, [orderId, waitSeconds, tick, apply]);

  // window.print() once per job, after the labels are committed to the DOM and fonts are ready.
  useEffect(() => {
    if (!job || printed.current === job.id) return;
    printed.current = job.id;
    const n = job.n;
    void Promise.resolve(typeof document !== 'undefined' ? document.fonts?.ready : undefined).catch(() => undefined).then(() => {
      if (!mounted.current) return;
      window.print();
      toast.show({ tone: 'success', title: `Sent ${n} labels to the printer dialog.` });
    });
  }, [job, toast]);

  const reprint = async () => {
    const ids = specimens.filter((s) => selected.has(s.specimen_id) && !inactive.has(s.specimen_id)).map((s) => s.specimen_id);
    if (ids.length === 0 || busy) return;
    setBusy(true); setReprintFail(null);
    const p = await printSpecimenLabels({ specimenIds: ids, copies });
    if (!mounted.current) return;
    setBusy(false);
    if (!p.ok) { setReprintFail(p); return; }
    apply(p.data, false);
  };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const retry = () => setTick((t) => t + 1);

  if (phase === 'preparing') return <section aria-label="Labels"><p role="status">Preparing labels…</p></section>;
  if (phase === 'timeout') return <section aria-label="Labels"><div className="lims-state"><p className="lims-state-title">{NOT_READY}</p><Button variant="primary" onPress={retry}>Retry</Button></div></section>;
  if (phase === 'fail' && fail) return <section aria-label="Labels"><Failure r={fail} onRetry={retry} /></section>;
  if (phase === 'encode') return <section aria-label="Labels"><ErrorState title="Labels can't be printed" body={ENCODE_ERROR} onRetry={retry} /></section>;

  const canPrint = !busy && specimens.some((s) => selected.has(s.specimen_id) && !inactive.has(s.specimen_id));
  return (
    <section aria-label="Labels">
      <style>{'@media print{body *{visibility:hidden}.lbl-print-region,.lbl-print-region *{visibility:visible}.lbl-print-region{position:absolute;left:0;top:0}}'}</style>
      <div className="lbl-noprint">
        <h1>Labels</h1>
        {meta ? <p>{meta.registrationNo} · {meta.patientName}</p> : null}
        {tooSmall ? <p role="alert">{TOO_SMALL}</p> : null}
        {reprintFail ? <Failure r={reprintFail} onRetry={() => { void reprint(); }} /> : null}
        <ul aria-label="Specimens">
          {specimens.map((s) => {
            const dead = inactive.has(s.specimen_id);
            return (
              <li key={s.specimen_id}>
                <label>
                  <input type="checkbox" checked={!dead && selected.has(s.specimen_id)} disabled={dead} onChange={() => toggle(s.specimen_id)} /> {s.barcode}{dead ? ' — Not printable (order cancelled)' : ''}
                </label>
              </li>
            );
          })}
        </ul>
        <div>
          <label htmlFor="lbl-copies">Copies</label>{' '}
          <select id="lbl-copies" value={copies} onChange={(e) => setCopies(clampCopies(Number(e.target.value)))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>{' '}
          <Button variant="primary" isDisabled={!canPrint} onPress={() => { void reprint(); }}>Print labels</Button>
        </div>
      </div>
      <div className="lbl-print-region" data-testid="print-region" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}
