'use client';
// SCR worksheet print view (PRD AC-07.4; 03-APP-FLOW §3.6; 04-UI-UX §3.15): rendered from #22 ONLY (a stored snapshot, never the live worklist). #22 writes the `worksheet.print` access row.
// The instrument name comes from C7 E23 via the BFF; on 403 an IdText (first 8 chars, full id in title) is shown, never a guessed name (08 A13 D-14).
// SPEC GAP, CR filed (.orchestra/cr/C5.T-26.md): WorksheetDto carries no created_by, rows no reg no / patient / priority, and no Code 128 component exists,
// so the sheet shows #, barcode text, test and blank Result / Remarks cells until the CR lands.
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { IdText } from '@lims/ui/components/IdText';
import { getWorksheetAction, listInstrumentsAction } from '../../server/worklist.actions';
import type { ActionResult, Worksheet } from '../../server/types';
import { Failure, utc } from '../shared';

type Load = { s: 'loading' } | { s: 'ok'; sheet: Worksheet; printedAt: string } | { s: 'fail'; r: Extract<ActionResult<unknown>, { ok: false }> };
type Names = { s: 'loading' } | { s: 'ok'; names: Map<string, string> } | { s: 'denied' };

const PRINT_CSS = `@page { size: A4 portrait; margin: 12mm; }
@media print { .ws-noprint { display: none !important; } .ws-sheet table { width: 100%; border-collapse: collapse; } .ws-sheet th, .ws-sheet td { border: 1px solid currentColor; padding: 4px 6px; } .ws-sheet td.ws-blank { height: 10mm; } }`;

export function WorksheetPrintPage({ worksheetId }: { worksheetId: string }) {
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [names, setNames] = useState<Names>({ s: 'loading' });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ s: 'loading' });
    void getWorksheetAction(worksheetId).then((r) => { if (live) setLoad(r.ok ? { s: 'ok', sheet: r.data, printedAt: new Date().toISOString() } : { s: 'fail', r }); });
    return () => { live = false; };
  }, [worksheetId, tick]);
  useEffect(() => {
    let live = true;
    void listInstrumentsAction().then((r) => { if (live) setNames(r.ok ? { s: 'ok', names: new Map(r.data.map((i) => [i.id, i.display_name])) } : { s: 'denied' }); });
    return () => { live = false; };
  }, []);

  if (load.s === 'loading') return <section aria-label="Worksheet"><p role="status">Loading…</p></section>;
  if (load.s === 'fail') return <section aria-label="Worksheet"><Failure r={load.r} onRetry={() => setTick((t) => t + 1)} /></section>;
  const { sheet, printedAt } = load;
  const instrument = sheet.instrument_id
    ? names.s === 'loading' ? null : names.s === 'ok' && names.names.has(sheet.instrument_id) ? names.names.get(sheet.instrument_id) : <IdText value={sheet.instrument_id} />
    : null;

  return (
    <section aria-label="Worksheet" className="ws-sheet" data-testid="print-region">
      <style>{PRINT_CSS}</style>
      <h1>{sheet.title}</h1>
      <p>Created {utc(sheet.created_at)} · {sheet.rows.length} tests{sheet.department_id ? <> · Department: <IdText value={sheet.department_id} /></> : null}{instrument ? <> · Instrument: {instrument}</> : null}</p>
      <div className="ws-noprint"><Button variant="primary" onPress={() => window.print()}>Print</Button></div>
      <table aria-label="Worksheet rows">
        <thead><tr><th scope="col">#</th><th scope="col">Barcode</th><th scope="col">Test</th><th scope="col">Result</th><th scope="col">Remarks</th></tr></thead>
        <tbody>
          {sheet.rows.map((r) => (
            <tr key={r.order_test_id}>
              <td>{r.position}</td><td>{r.barcode ?? '—'}</td><td>{r.test_code}</td><td className="ws-blank" /><td className="ws-blank" />
            </tr>
          ))}
        </tbody>
      </table>
      <p>Printed {utc(printedAt)} — snapshot; check the worklist for current status.</p>
    </section>
  );
}
