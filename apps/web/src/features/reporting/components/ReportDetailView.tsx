'use client';
// 04-UI-UX §2.2 Report detail: header, items, versions timeline, deliveries; Release / Print / Download + ⋯ menu (Regenerate, Revoke QR).
// Held for dues → C4 override dialog (billing.release.override) which reopens the release dialog. Shortcuts §1.1 on staff.reporting.report.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { Menu } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Switch } from '@lims/ui/components/Switch';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { isOnline, useOfflineFlows, useOfflineSnapshot } from '@/core/offline/ui/OfflineProvider';
import { ReportOfflineMarker } from '@/core/offline/ui/OfflineParts';
import { createPrintAction, getPrintAction, listCodesAction, listPrintProfilesAction, listOverrideReasonsAction, recordOverrideAction, regenerateAction, releaseVersionAction, retryRenderAction, revokeQrAction } from '../server/actions';
import { PAPER_LABEL, type ReportDetail, type ReportItem, type VersionSummary } from '../server/types';
import { Chip, When, errorText, formatNpr, hasPerm, humanize, newKey } from './format';
import { NumberInput, rangeError } from './NumberInput';
import { ReasonDialog } from './ReasonDialog';
import { SimpleTable, type Col } from './SimpleTable';
import { useShortcuts } from './useShortcuts';
import './report-preview.css';

type Dlg = 'release' | 'print' | 'regenerate' | 'revoke' | 'override' | null;
/** T0D-PRINTCFG-1 (LD-316): createReportPrint takes only variant letterhead | plain, so "Typed header and footer" sends plain and the saved print profile decides. */
type Paper = 'letterhead' | 'plain' | 'typed';
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
  const flows = useOfflineFlows();
  const snap = useOfflineSnapshot();
  const offline = !!flows?.printReport && !!snap && !isOnline(snap); // T0D-OFFLINE-4 (LD-322)
  const [dlg, setDlg] = useState<Dlg>(null);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [heldBalance, setHeldBalance] = useState<number | undefined | null>(null); // null = no blocked release seen in this session
  const [audiences, setAudiences] = useState<string[]>(report.computed_audiences ?? ['patient']);
  const [printOnly, setPrintOnly] = useState(false);
  const [variant, setVariant] = useState<Paper>('letterhead');
  const [applies, setApplies] = useState('checking…');
  // T0D-PRINTCFG-1 done_when (3): show the lab default report profile; a refused read (no reporting.settings.manage) never blocks printing.
  useEffect(() => {
    if (dlg !== 'print') return;
    let alive = true;
    listPrintProfilesAction('report').then((r) => {
      if (!alive) return;
      const p = r.ok ? r.data.find((x) => !x.branch_id && !x.recipient_type) : undefined;
      setApplies(!r.ok ? 'not known (the print settings could not be read)' : p ? `Lab default, ${PAPER_LABEL[p.paper_mode] ?? p.paper_mode}` : 'Lab default (no print settings saved yet)');
    }, () => { if (alive) setApplies('not known (the print settings could not be read)'); });
    return () => { alive = false; };
  }, [dlg]);
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
      if (offline) {
        // T0D-OFFLINE-4 (LD-322 decision 2; done_when 4): allowed only when every sign-off is accepted by the server or captured on this device;
        // queues the report.print_marker operation and prints this page with the issued offline, pending sync marker
        const q = await flows!.printReport!({ report_version_id: latest.id, variant: variant === 'letterhead' ? 'letterhead' : 'plain', copies });
        if (!q.ok) { setDlgError(q.message); return; }
        setDlg(null); toast.show({ tone: 'success', title: t('offline.saved_offline') });
        setTimeout(() => window.print(), 0);
        return;
      }
      const r = await createPrintAction(latest.id, { variant: variant === 'letterhead' ? 'letterhead' : 'plain', copies }, key.current);
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
  // T0D-UIGUARD-1-REPORTING (LD-436, LD-439 a): versions are kit Timeline rows (time = released, else rendered); chip, basis, pages and Download ride in `extra`.
  const versionItem = (v: VersionSummary) => ({
    at: v.released_at ?? v.rendered_at ?? '',
    label: `v${v.version_no} ${KIND[v.report_kind ?? 'final'] ?? 'Amended'}`,
    extra: (
      <>
        <Chip status={v.status} />
        {v.release_basis ? <> · basis: {BASIS[v.release_basis] ?? humanize(v.release_basis)}</> : null}
        {v.page_count ? <> · {v.page_count} pages</> : null}
        {['rendered', 'released', 'superseded'].includes(v.status) ? <> · <a className="lims-link" href={pdfHref(v.id)} aria-label={`Download version ${v.version_no}`}>Download</a></> : null}
      </>
    ),
  });

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

      {latest ? <ReportOfflineMarker reportVersionId={latest.id} /> : null}
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
      {/* T0D-UIGUARD-1-REPORTING (LD-436 Card title rows, LD-439 a): Report, Items, Versions, Deliveries are kit Cards with a title row. */}
      <Card title="Report">
        <dl className="lims-dl">
          <dt>Patient</dt><dd>{report.patient_display_name}{report.age_display ? `, ${report.age_display}` : ''}{report.sex ? ` ${report.sex}` : ''}</dd>
          <dt>Centre</dt><dd>{report.centre_code ?? '—'}</dd>
          <dt>Referrer</dt><dd>{report.referrer_name ?? 'SELF'}</dd>
          <dt>Registered</dt><dd><When value={report.registered_at} /></dd>
        </dl>
      </Card>
      <Card title="Items">
        <SimpleTable caption="Report items" columns={itemCols} rows={report.items} getRowId={(i) => i.order_item_id} empty={{ title: 'No items.' }} />
      </Card>
      <Card title="Versions">
        {live.length === 0 ? <p>No versions yet.</p> : <Timeline aria-label="Report versions" items={live.map(versionItem)} />}
        {discarded.length > 0 ? (
          <>
            <Button size="sm" variant="ghost" onPress={() => setShowDiscarded(!showDiscarded)}>{showDiscarded ? 'Hide discarded' : 'Show discarded'}</Button>
            {showDiscarded ? <Timeline aria-label="Discarded versions" items={discarded.map(versionItem)} /> : null}
          </>
        ) : null}
      </Card>
      <Card title="Deliveries">
        <div className="rpt-chips" role="group" aria-label="Delivery counts">
          {(['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'] as const).map((s) => <Chip key={s} status={s} label={`${humanize(s)} ${ds[s]}`} />)}
        </div>
        <a className="lims-link" href={`/reporting/deliveries?report_id=${report.id}`}>Open delivery log filtered to this report</a>
      </Card>

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
        <RadioGroup<Paper> label="Paper" name="variant" value={variant} onChange={setVariant} options={[{ value: 'letterhead', label: 'With letterhead' }, { value: 'plain', label: 'Plain paper (my own pre-printed pad)' }, { value: 'typed', label: 'Typed header and footer' }]} />
        <NumberInput label="Copies" name="copies" min={1} max={5} value={copies} onChange={setCopies} />
        <p className="lims-description">Profile that applies: {applies}</p>
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
