'use client';
// 04-UI-UX §2.2 Report detail: header, items, versions timeline, deliveries; Release / Print / Download + ⋯ menu (Regenerate, Revoke QR).
// Held for dues → C4 override dialog (billing.release.override) which reopens the release dialog. Shortcuts §1.1 on staff.reporting.report.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { Menu } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { createPrintAction, getPrintAction, listCodesAction, listOverrideReasonsAction, recordOverrideAction, regenerateAction, releaseVersionAction, retryRenderAction, revokeQrAction } from '../server/actions';
import type { ReportDetail, ReportItem, VersionSummary } from '../server/types';
import { Chip, When, errorText, formatNpr, hasPerm, humanize, newKey } from './format';
import { NumberInput, rangeError } from './NumberInput';
import { ReasonDialog } from './ReasonDialog';
import { SimpleTable, type Col } from './SimpleTable';
import { useShortcuts } from './useShortcuts';
import './report-preview.css';

type Dlg = 'release' | 'print' | 'regenerate' | 'revoke' | 'override' | null;
const AUDIENCE: Record<string, string> = { patient: 'Patient', referrer: 'Referring doctor', centre: 'Centre' };
const KIND: Record<string, string> = { final: 'Final', amended: 'Amended', addendum: 'Addendum', partial: 'Partial', preliminary: 'Preliminary' };
const BASIS: Record<string, string> = { paid_in_full: 'Paid in full', credit_party: 'Credit party', override: 'Override', no_dues: 'No dues' };
const REVIEW: Record<string, string> = { released_order_cancelled: 'The order was cancelled after this report was released.' };
const PRINT_POLL_MS = 5_000;
const PRINT_POLL_MAX = 24; // 24 × 5 s = 2 min, then a manual Refresh (02-CV §2.4)
const pdfHref = (versionId: string) => `/reporting/report-versions/${versionId}/pdf`;

export interface ReportDetailViewProps { report: ReportDetail; permissions: readonly string[] }

export function ReportDetailView({ report, permissions }: ReportDetailViewProps) {
  const router = useRouter();
  const toast = useToast();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [heldBalance, setHeldBalance] = useState<number | undefined | null>(null); // null = no blocked release seen in this session
  const [audiences, setAudiences] = useState<string[]>(report.computed_audiences ?? ['patient']);
  const [printOnly, setPrintOnly] = useState(false);
  const [variant, setVariant] = useState<'letterhead' | 'plain'>('letterhead');
  const [copies, setCopies] = useState<number | ''>(1);
  const [print, setPrint] = useState<{ id: string; state: string } | null>(null);
  const [printTicks, setPrintTicks] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dlgError, setDlgError] = useState<string>();
  const key = useRef(newKey());
  const rekey = () => { key.current = newKey(); };

  const versions = [...report.versions].sort((a, b) => b.version_no - a.version_no);
  const live = versions.filter((v) => v.status !== 'discarded');
  const discarded = versions.filter((v) => v.status === 'discarded');
  const latest = live[0];
  const released = live.find((v) => v.status === 'released');
  const canRelease = hasPerm(permissions, 'reporting.report.release') && latest?.status === 'rendered';
  const printable = !!latest && ['rendered', 'released'].includes(latest.status);
  const canPrint = printable && hasPerm(permissions, 'reporting.report.print') && (latest.status === 'released' || hasPerm(permissions, 'reporting.report.release'));
  const downloadable = live.filter((v) => ['rendered', 'released', 'superseded'].includes(v.status));
  const canRegenerate = hasPerm(permissions, 'reporting.report.regenerate');
  const canRevoke = !!released && hasPerm(permissions, 'reporting.token.revoke');
  const canOverride = hasPerm(permissions, 'billing.release.override');
  const held = heldBalance !== null || report.display_status === 'held';
  const balance = heldBalance ?? report.balance_due_paisa;
  const renderFailed = latest?.status === 'render_failed' || report.display_status === 'render_failed';

  const download = () => {
    const v = downloadable[0];
    if (!v) return;
    const a = document.createElement('a');
    a.href = pdfHref(v.id);
    a.download = '';
    a.click();
  };
  useShortcuts('staff.reporting.report', [
    ...(canRelease ? [{ key: 'Alt+R', description: 'Release the latest version', run: () => setDlg('release') }] : []),
    ...(canPrint ? [{ key: 'Alt+P', description: 'Print', run: () => setDlg('print') }] : []),
    { key: 'Alt+D', description: 'Download the PDF', run: download },
  ], [canRelease, canPrint, downloadable[0]?.id]);

  // Print job state: 5 s for up to 2 min (02-CV §2.4)
  useEffect(() => {
    if (!print || print.state === 'ready' || print.state === 'failed' || printTicks >= PRINT_POLL_MAX) return;
    const t = setTimeout(async () => {
      const r = await getPrintAction(print.id);
      if (r.ok) setPrint({ id: print.id, state: r.data.state });
      setPrintTicks((n) => n + 1);
    }, PRINT_POLL_MS);
    return () => clearTimeout(t);
  }, [print, printTicks]);

  const fail = (code: string, title: string) => toast.show({ tone: 'danger', title, description: errorText(code) });

  const doRelease = async () => {
    if (!latest || busy) return;
    setBusy(true);
    setDlgError(undefined);
    try {
      const r = await releaseVersionAction(latest.id, latest.version, { audiences: audiences.length ? audiences : ['patient'], ...(printOnly ? { suppress_notifications: true } : {}) }, key.current);
      if (r.ok) { rekey(); setDlg(null); toast.show({ tone: 'success', title: 'Report released.' }); router.refresh(); return; }
      if (r.code === 'reporting.release_blocked_due') { setHeldBalance(typeof r.extra?.['balance_due_paisa'] === 'number' ? r.extra['balance_due_paisa'] : undefined); setDlg(null); return; }
      setDlgError(errorText(r.code));
    } finally { setBusy(false); }
  };
  const doPrint = async () => {
    if (!latest || busy || rangeError('Copies', copies, 1, 5) || copies === '') return;
    setBusy(true);
    setDlgError(undefined);
    try {
      const r = await createPrintAction(latest.id, { variant, copies }, key.current);
      if (r.ok) { rekey(); setDlg(null); setPrint(r.data); setPrintTicks(0); return; }
      setDlgError(errorText(r.code));
    } finally { setBusy(false); }
  };
  const doRetry = async () => {
    if (!latest) return;
    const r = await retryRenderAction(latest.id, key.current);
    if (r.ok) { rekey(); toast.show({ tone: 'success', title: 'Rendering again.' }); router.refresh(); } else fail(r.code, 'Could not retry the render');
  };

  const itemCols: Col<ReportItem>[] = [
    { id: 'test', header: 'Test', rowHeader: true, cell: (i) => (i.narrative_report_id ? <a className="lims-link" href={`/reporting/narratives/${i.narrative_report_id}`}>{i.test_names.join(', ')}</a> : i.test_names.join(', ')) },
    { id: 'lab', header: 'Lab', cell: (i) => (i.requires_lab ? (i.lab_ready ? 'Ready' : 'Waiting') : '—') },
    { id: 'narr', header: 'Narrative', cell: (i) => (i.requires_narrative ? (i.narrative_ready ? 'Signed' : 'Waiting') : '—') },
    { id: 'out', header: 'Outsourced', cell: (i) => (i.requires_outsourced ? (i.outsourced_ready ? 'Confirmed' : 'Waiting') : '—') },
    { id: 'st', header: 'Status', cell: (i) => humanize(i.item_status) },
  ];
  const versionRow = (v: VersionSummary) => (
    <li key={v.id} className="lims-list-row">
      <strong>{`v${v.version_no} ${KIND[v.report_kind ?? 'final'] ?? 'Amended'}`}</strong>
      {' '}<Chip status={v.status} />
      {v.released_at ? <> · Released <When value={v.released_at} /></> : null}
      {v.release_basis ? <> · basis: {BASIS[v.release_basis] ?? humanize(v.release_basis)}</> : null}
      {v.page_count ? <> · {v.page_count} pages</> : null}
      {['rendered', 'released', 'superseded'].includes(v.status) ? <> · <a className="lims-link" href={pdfHref(v.id)} aria-label={`Download version ${v.version_no}`}>Download</a></> : null}
    </li>
  );

  const menuItems = [
    ...(canRegenerate ? [{ id: 'regenerate', label: 'Regenerate' }] : []),
    ...(canRevoke ? [{ id: 'revoke', label: 'Revoke QR', isDanger: true }] : []),
  ];
  const ds = report.deliveries_summary;
  return (
    <section aria-label="Report">
      <PageHeader
        title={`Report · ${report.registration_no}`}
        helpKey="reporting.report"
        breadcrumbs={[{ label: 'Reports', href: '/reporting' }, { label: report.registration_no }]}
        status={<Chip status={report.display_status} />}
        actions={
          <>
            {canRelease ? <Button variant="primary" shortcut="Alt+R" onPress={() => { setDlgError(undefined); setDlg('release'); }}>Release</Button> : null}
            {canPrint ? <Button shortcut="Alt+P" onPress={() => { setDlgError(undefined); setDlg('print'); }}>Print</Button> : null}
            {downloadable[0] ? <a className="lims-btn lims-btn-secondary lims-btn-md" href={pdfHref(downloadable[0].id)}>Download</a> : null}
            {menuItems.length ? <Menu trigger={<Button>More actions</Button>} items={menuItems} onAction={(id) => { setDlgError(undefined); setDlg(id as Dlg); }} /> : null}
          </>
        }
      />

      {held ? (
        <Banner tone="warning" title={balance !== undefined ? `Held for dues — ${formatNpr(balance)} outstanding` : 'Held for dues'} {...(canOverride ? { action: { label: 'Record override', onPress: () => setDlg('override') } } : {})} />
      ) : null}
      {renderFailed ? (
        <Banner tone="danger" title="The report could not be rendered" {...(hasPerm(permissions, 'reporting.report.render') ? { action: { label: 'Retry', onPress: () => void doRetry() } } : {})}>
          {latest?.last_render_error_code ? <code>{latest.last_render_error_code}</code> : null}
        </Banner>
      ) : null}
      {report.review_flag ? <Banner tone="warning" title={REVIEW[report.review_flag] ?? humanize(report.review_flag)} /> : null}
      {print ? (
        <p role="status">
          {print.state === 'ready' ? <>Print ready. <a className="lims-link" href={`/reporting/prints/${print.id}/pdf`}>Download the print PDF</a></>
            : print.state === 'failed' ? 'The print could not be prepared.'
              : printTicks >= PRINT_POLL_MAX ? <>Still preparing. <Button size="sm" variant="ghost" onPress={() => setPrintTicks(0)}>Refresh</Button></>
                : 'Preparing print…'}
        </p>
      ) : null}

      {downloadable[0] ? (
        <section className="rpt-preview" aria-label="Report preview">
          {/* LD-140: no inline <object> preview; it would call the logged, rate-limited download route on every render (needs a CR for an inline view endpoint). */}
          <div className="rpt-preview-paper">
            <a className="lims-link" href={pdfHref(downloadable[0].id)}>Download the report PDF</a>
          </div>
        </section>
      ) : null}
      <div className="lims-card">
        <h2>Report</h2>
        <dl className="lims-dl">
          <dt>Patient</dt><dd>{report.patient_display_name}{report.age_display ? `, ${report.age_display}` : ''}{report.sex ? ` ${report.sex}` : ''}</dd>
          <dt>Centre</dt><dd>{report.centre_code ?? '—'}</dd>
          <dt>Referrer</dt><dd>{report.referrer_name ?? 'SELF'}</dd>
          <dt>Registered</dt><dd><When value={report.registered_at} /></dd>
        </dl>
      </div>
      <div className="lims-card">
        <h2>Items</h2>
        <SimpleTable caption="Report items" columns={itemCols} rows={report.items} getRowId={(i) => i.order_item_id} empty={{ title: 'No items.' }} />
      </div>
      <div className="lims-card">
        <h2>Versions</h2>
        {live.length === 0 ? <p>No versions yet.</p> : <ol className="lims-list" aria-label="Report versions">{live.map(versionRow)}</ol>}
        {discarded.length > 0 ? (
          <>
            <Button size="sm" variant="ghost" onPress={() => setShowDiscarded(!showDiscarded)}>{showDiscarded ? 'Hide discarded' : 'Show discarded'}</Button>
            {showDiscarded ? <ol className="lims-list" aria-label="Discarded versions">{discarded.map(versionRow)}</ol> : null}
          </>
        ) : null}
      </div>
      <div className="lims-card">
        <h2>Deliveries</h2>
        <ul className="rpt-chips" aria-label="Delivery counts">
          {(['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'] as const).map((s) => <li key={s}><Chip status={s} label={`${humanize(s)} ${ds[s]}`} /></li>)}
        </ul>
        <a className="lims-link" href={`/reporting/deliveries?report_id=${report.id}`}>Open delivery log filtered to this report</a>
      </div>

      <Dialog
        title="Release report" isOpen={dlg === 'release'} onClose={() => setDlg(null)} size="sm" isDismissable={false}
        footer={<><Button variant="ghost" onPress={() => setDlg(null)} isDisabled={busy}>Cancel</Button><Button variant="primary" onPress={() => void doRelease()} isLoading={busy}>Release</Button></>}
      >
        <fieldset className="lims-fieldset">
          <legend>Send to</legend>
          {(report.computed_audiences ?? ['patient']).map((a) => (
            <Checkbox key={a} label={AUDIENCE[a] ?? humanize(a)} isSelected={a === 'patient' || audiences.includes(a)} isDisabled={a === 'patient'} onChange={(on) => setAudiences((cur) => (on ? [...cur, a] : cur.filter((x) => x !== a)))} />
          ))}
        </fieldset>
        <Switch label="Print only (send no messages)" isSelected={printOnly} onChange={setPrintOnly} />
        {dlgError ? <p role="alert" className="lims-error">{dlgError}</p> : null}
      </Dialog>

      <Dialog
        title="Print report" isOpen={dlg === 'print'} onClose={() => setDlg(null)} size="sm" isDismissable={false}
        footer={<><Button variant="ghost" onPress={() => setDlg(null)} isDisabled={busy}>Cancel</Button><Button variant="primary" onPress={() => void doPrint()} isLoading={busy}>Print</Button></>}
      >
        <RadioGroup<'letterhead' | 'plain'> label="Paper" name="variant" value={variant} onChange={setVariant} options={[{ value: 'letterhead', label: 'With letterhead' }, { value: 'plain', label: 'Plain paper (pre-printed letterhead)' }]} />
        <NumberInput label="Copies" name="copies" min={1} max={5} value={copies} onChange={setCopies} />
        {latest && latest.status !== 'released' ? <p className="lims-description">This version is not released yet; the print is stamped NOT RELEASED.</p> : null}
        {dlgError ? <p role="alert" className="lims-error">{dlgError}</p> : null}
      </Dialog>

      <ReasonDialog
        title="Regenerate report" confirmLabel="Regenerate" isOpen={dlg === 'regenerate'} onCancel={() => setDlg(null)} load={() => listCodesAction('regeneration_reasons')} textRequired="other"
        body="After a released version, the new version prints as AMENDED REPORT with this reason, except 'Smart summary added'."
        onConfirm={async (r) => {
          const res = await regenerateAction(report.id, { reason_code: r.reasonCode, ...(r.reasonText ? { reason_text: r.reasonText } : {}) }, key.current);
          if (!res.ok) return errorText(res.code);
          rekey(); setDlg(null); toast.show({ tone: 'success', title: 'Regeneration started.' }); router.refresh();
        }}
      />
      <ReasonDialog
        title="Revoke QR code" confirmLabel="Revoke QR" tone="danger" isOpen={dlg === 'revoke'} onCancel={() => setDlg(null)} load={() => listCodesAction('token_revoke_reasons')} textRequired="other"
        body="Anyone who scans this report's QR code will see 'could not be verified'. This cannot be undone."
        onConfirm={async (r) => {
          if (!released) return 'No released version';
          const res = await revokeQrAction(released.id, { reason_code: r.reasonCode, ...(r.reasonText ? { reason_text: r.reasonText } : {}) }, key.current);
          if (!res.ok) return errorText(res.code);
          rekey(); setDlg(null); toast.show({ tone: 'success', title: 'QR code revoked.' }); router.refresh();
        }}
      />
      <ReasonDialog
        title="Record a release override" confirmLabel="Record override" isOpen={dlg === 'override'} onCancel={() => setDlg(null)} load={listOverrideReasonsAction} textLabel="Note" textRequired maxText={500}
        body="The report is held for dues. An override lets it be released without full payment. It is recorded against your name."
        onConfirm={async (r) => {
          const until = (document.getElementById('override-valid-until') as HTMLInputElement | null)?.value;
          const res = await recordOverrideAction(report.order_id, { reason_code: r.reasonCode, reason_text: r.reasonText, ...(until ? { valid_until: `${until}T23:59:59+05:45` } : {}) }, key.current);
          if (!res.ok) return errorText(res.code);
          rekey(); setDlgError(undefined); setDlg('release'); // the release dialog reopens (04-UI-UX §2.2)
        }}
      >
        <div className="lims-field">
          <label className="lims-label" htmlFor="override-valid-until">Valid until (optional)</label>
          <input id="override-valid-until" type="date" className="lims-input" />
        </div>
      </ReasonDialog>
    </section>
  );
}
