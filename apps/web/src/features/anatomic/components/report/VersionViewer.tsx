'use client';
// 04-UI-UX §4.2.7 "After sign-out": the editor is replaced by the snapshot of a signed version (R7; the current one first), a "Versions" DataTable (R6; choosing a row shows that
// snapshot), [Revise] / [Amend] (AC-10.1, AC-10.2), [Add addendum] and the addenda of the case (R8-R10). Snapshot text, captions and addenda are text, never HTML; storage paths of
// images never reach the page (REQ-SEC-088). LD-140 (2026-11-13, binding): kit components and token class names only; [Revise]/[Amend] is the page's one primary button.
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { getVersionAction, listVersionsAction } from '../../server/actions.report';
import type { Addendum, VersionFull, VersionSummary } from '../../server/report.types';
import type { CaseDetail } from '../../server/types';
import { Chip, When, type Fail, type Tone } from '../common';
import { AddendumDrawer, ADDENDUM_KINDS } from './AddendumDrawer';
import { isAmendment } from './ChangeDialog';
import { Block } from './ReportPreview';
import './report.css';

const KIND = { original: 'Original', revision: 'Revision', amendment: 'Amendment', addendum: 'Addendum' } as const;
const LAB: Record<string, Tone> = { pending: 'neutral', resulted: 'warning', verified: 'warning', approved: 'success', cancelled: 'neutral' };
const word = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Snapshot({ v }: { v: VersionFull }) {
  return (
    <Card title={`Version ${v.version_no}`}>
      <p className="lims-description">{KIND[v.version_kind] ?? v.version_kind}, signed <When value={v.signed_at} time /> by {v.signed_by_display_name}</p>
      <Block title="Gross" text={v.gross_text} />
      <Block title="Microscopy" text={v.microscopy_text} />
      <Block title="Diagnosis" text={v.impression_text} />
      <Block title="Comment" text={v.comment_text} />
      <section>
        <h3 className="lims-card-title">Synoptic</h3>
        {v.synoptic.length === 0 ? <p className="lims-description">None.</p> : null}
        {v.synoptic.map((s, i) => (
          <div key={`${s.template_key}-${i}`}>
            <p><strong>{s.title}</strong></p>
            {s.sections.map((x, j) => (
              <div key={j}>
                <p>{x.heading}</p>
                <ul>{x.items.map((it, k) => <li key={k}>{it.label}: {it.value}</li>)}</ul>
              </div>
            ))}
          </div>
        ))}
      </section>
      <section>
        <h3 className="lims-card-title">Ancillary</h3>
        {v.ancillary.length === 0 ? <p className="lims-description">None.</p> : null}
        <ul>{v.ancillary.map((a, i) => <li key={i}><strong>{[a.stain_display, a.block_label].filter(Boolean).join(' on ')}</strong>: <span className="lims-report-text">{a.result_text}</span></li>)}</ul>
      </section>
      <section>
        <h3 className="lims-card-title">Slides</h3>
        <ul>{v.slides.map((s, i) => <li key={i}>{s.label}{s.stain_display ? ` — ${s.stain_display}` : ''}</li>)}</ul>
      </section>
      <section>
        <h3 className="lims-card-title">Images</h3>
        {v.images.length === 0 ? <p className="lims-description">None.</p> : null}
        <ol>{v.images.map((i, n) => <li key={n}>{i.caption || `Image ${n + 1}`}</li>)}</ol>
      </section>
      <section>
        <h3 className="lims-card-title">Codes</h3>
        {v.diagnosis_codes.length === 0 ? <p className="lims-description">None.</p> : null}
        <ul>{v.diagnosis_codes.map((c) => <li key={c.code}>{c.code} — {c.display}</li>)}</ul>
      </section>
    </Card>
  );
}

function AddendaList({ addenda, canWork, onEdit }: { addenda: readonly Addendum[]; canWork: boolean; onEdit: (a: Addendum) => void }) {
  if (addenda.length === 0) return null;
  return (
    <section aria-labelledby="report-addenda">
      <h2 id="report-addenda" className="lims-card-title">Addenda</h2>
      <ul>
        {addenda.map((a) => (
          <li key={a.id}>
            <Card title={ADDENDUM_KINDS.find((k) => k.value === a.kind)?.label ?? a.kind}>
              <Chip size="sm" tone={a.status === 'signed' ? 'success' : 'neutral'} label={a.status === 'signed' ? 'Signed' : 'Draft'} />
              <p className="lims-report-text">{a.text}</p>
              {a.status === 'signed' ? (
                <p className="lims-description">Signed <When value={a.signed_at} time /> by {a.signed_by_display_name ?? '—'}{a.report_version_no ? `, report version ${a.report_version_no}` : ''}</p>
              ) : canWork ? (
                <Button variant="ghost" onPress={() => onEdit(a)}>Edit addendum</Button>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function VersionViewer({ detail, canWork, canSignOut, reasonDisplay, onChange, onFail, onMfa }: {
  detail: CaseDetail; canWork: boolean; canSignOut: boolean; reasonDisplay: (code: string | undefined) => string | undefined;
  onChange: () => void; onFail: (f: Fail) => void; onMfa: () => void;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [shown, setShown] = useState(detail.current_version_no);
  const [snapshot, setSnapshot] = useState<VersionFull>();
  const [drawer, setDrawer] = useState<{ addendum?: Addendum } | undefined>();
  const can = (op: string) => detail.allowed_actions.includes(op);

  useEffect(() => {
    void listVersionsAction(detail.id).then((r) => (r.ok ? setVersions([...r.data].sort((a, b) => b.version_no - a.version_no)) : onFail(r)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.current_version_no]);
  useEffect(() => {
    let live = true;
    void getVersionAction(detail.id, shown).then((r) => live && (r.ok ? setSnapshot(r.data) : onFail(r)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, shown]);

  const columns: ColumnDef<VersionSummary>[] = [
    { id: 'version', header: 'Version', isRowHeader: true, cell: (r) => String(r.version_no) },
    { id: 'kind', header: 'Kind', cell: (r) => KIND[r.version_kind] ?? r.version_kind },
    { id: 'signed', header: 'Signed', cell: (r) => <When value={r.signed_at} time /> },
    { id: 'by', header: 'By', cell: (r) => r.signed_by_display_name },
    { id: 'reason', header: 'Reason', cell: (r) => (r.change_reason_code ? (reasonDisplay(r.change_reason_code) ?? r.change_reason_code) : '—') },
    {
      id: 'lab',
      header: 'Lab status at submit',
      cell: (r) => {
        const s = [...new Set(r.submissions.flatMap((x) => (x.lab_status_at_submit ? [x.lab_status_at_submit] : [])))];
        return s.length ? <>{s.map((x) => <Chip key={x} size="sm" tone={LAB[x] ?? 'neutral'} label={word(x)} />)}</> : '—';
      },
    },
  ];
  const amend = isAmendment(detail);

  return (
    <>
      <div>
        {canSignOut && can('startAnatomicCaseChange') ? <Button variant="primary" onPress={() => onChange()}>{amend ? 'Amend' : 'Revise'}</Button> : null}
        {can('createAnatomicAddendum') ? <Button onPress={() => setDrawer({})}>Add addendum</Button> : null}
      </div>
      {snapshot ? <Snapshot v={snapshot} /> : <p role="status" className="lims-description">Loading version…</p>}
      <section aria-labelledby="report-versions">
        <h2 id="report-versions" className="lims-card-title">Versions</h2>
        <DataTable<VersionSummary>
          caption="Versions"
          columns={columns}
          rows={versions}
          getRowId={(r) => String(r.version_no)}
          emptyState={{ title: 'No versions yet.' }}
          selection={{ mode: 'single', selectedIds: new Set([String(shown)]), onChange: (ids) => { const n = Number([...ids][0]); if (n >= 1) setShown(n); } }}
        />
      </section>
      <AddendaList addenda={detail.addenda ?? []} canWork={canWork} onEdit={(a) => setDrawer({ addendum: a })} />
      {drawer ? <AddendumDrawer key={drawer.addendum?.id ?? 'new'} detail={detail} addendum={drawer.addendum} canSign={canSignOut} isOpen onClose={() => setDrawer(undefined)} onFail={onFail} onMfa={onMfa} /> : null}
    </>
  );
}
