// C5.T-20 — history side panel (Drawer, F2) and trend dialog (TimeSeriesChart, F3), 04-UI-UX §3.7. Server data is shown as plain text (S-14).
// The panels are given ready data: the grid loads first and opens after, so an open panel is never half empty.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { FlagBadge, type ResultFlag } from '@lims/ui/components/FlagBadge';
import { TimeSeriesChart } from '@lims/ui/components/TimeSeriesChart';
import type { HistoryRow, TrendResponse } from '../../server/types';
import { formatDateTime } from './resultModel';

const MAX_HISTORY = 5;
const MIN_POINTS = 2;
const year = (iso: string) => formatDateTime(iso).slice(6, 10);
const dayTime = (iso: string) => formatDateTime(iso).replace(/^(\d\d\/\d\d)\/\d{4}/, '$1');

/** Last 5 approved results, newest first. The year is a group heading so a row reads "08/11 10:45 AM". */
export function HistoryPanel({ analyte, rows, onClose }: { analyte: string; rows: readonly HistoryRow[]; onClose: () => void }) {
  const list = [...rows].sort((a, b) => Date.parse(b.approved_at) - Date.parse(a.approved_at)).slice(0, MAX_HISTORY);
  const groups = [...new Set(list.map((r) => year(r.approved_at)))];
  return (
    <Drawer title={`History — ${analyte}`} isOpen onClose={onClose}>
      {list.length === 0 ? (
        <p>No previous results for this patient.</p>
      ) : (
        <table>
          <caption className="lims-visually-hidden">Last approved results of {analyte}</caption>
          <thead>
            <tr><th scope="col">Date</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Flag</th><th scope="col">Version</th></tr>
          </thead>
          {groups.map((y) => (
            <tbody key={y}>
              <tr><th scope="colgroup" colSpan={5}>{y}</th></tr>
              {list.filter((r) => year(r.approved_at) === y).map((r) => (
                <tr key={r.result_id}>
                  <td><time dateTime={r.approved_at}>{dayTime(r.approved_at)}</time></td>
                  <td>{r.value}</td>
                  <td>{r.unit_code ?? ''}</td>
                  <td>{r.flag ? <FlagBadge flag={r.flag as ResultFlag} /> : null}</td>
                  <td>{`v${r.version_no}`}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
    </Drawer>
  );
}

/** Same-unit points are plotted; the others are listed under "Not plotted (different unit)". `unit` = the current result's unit (else the newest point's). */
export function TrendDialog({ analyte, unit, data, onClose }: { analyte: string; unit?: string | undefined; data: TrendResponse; onClose: () => void }) {
  const [asTable, setAsTable] = useState(false);
  const pts = [...data.points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const u = unit ?? data.reference_band?.unit_code ?? pts[pts.length - 1]?.unit_code;
  const plotted = pts.filter((p) => (p.unit_code ?? u) === u);
  const other = pts.filter((p) => (p.unit_code ?? u) !== u);
  const band = data.reference_band && (data.reference_band.unit_code ?? u) === u ? { ...(data.reference_band.low ? { low: data.reference_band.low } : {}), ...(data.reference_band.high ? { high: data.reference_band.high } : {}) } : undefined;
  return (
    <Dialog title={`Trend — ${analyte}`} isOpen onClose={onClose} size="lg">
      {plotted.length < MIN_POINTS ? (
        <p>Not enough history to draw a trend (needs 2 results).</p>
      ) : (
        <>
          <TimeSeriesChart title={`${analyte} trend`} series={[{ id: 'v', label: analyte, points: plotted.map((p) => ({ at: p.at, value: p.value })) }]} {...(band ? { referenceBand: band } : {})} {...(u ? { unit: u } : {})} />
          <Button variant="ghost" onPress={() => setAsTable((v) => !v)}>{asTable ? 'Hide table' : 'Show as table'}</Button>
          {asTable ? (
            <table>
              <caption className="lims-visually-hidden">{analyte} values</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Value</th><th scope="col">Unit</th></tr></thead>
              <tbody>{plotted.map((p) => <tr key={p.result_id}><td>{formatDateTime(p.at)}</td><td>{p.value}</td><td>{p.unit_code ?? ''}</td></tr>)}</tbody>
            </table>
          ) : null}
        </>
      )}
      {other.length ? (
        <section>
          <h3>Not plotted (different unit)</h3>
          <table>
            <thead><tr><th scope="col">Date</th><th scope="col">Value</th><th scope="col">Unit</th></tr></thead>
            <tbody>{other.map((p) => <tr key={p.result_id}><td>{formatDateTime(p.at)}</td><td>{p.value}</td><td>{p.unit_code ?? ''}</td></tr>)}</tbody>
          </table>
        </section>
      ) : null}
    </Dialog>
  );
}
