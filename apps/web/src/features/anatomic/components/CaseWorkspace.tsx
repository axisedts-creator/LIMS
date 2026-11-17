'use client';
// 04-UI-UX §4.2 Case workspace shell: PageHeader (breadcrumbs, status chip, Actions menu, one primary stage button) → banners → DescriptionList → Tabs
// (Overview + Parts & gross in T-19; Blocks & slides, Stains and Images in T-20; Molecular in T-22; Report arrives with T-21+). AC-13.4 (highlight ids are inert here), REQ-SEC-081/088.
// LD-140 (2026-11-13, binding): kit components and token class names only — no hex colours, pixel radii or inline style objects; exactly one primary
// button on the page (the next stage of the case); every status shows tone, icon and word (see common.tsx Chip). Server text is rendered as text, never HTML.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { IdText } from '@lims/ui/components/IdText';
import { Menu } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import { AccessionDialog } from '../forms/AccessionDialog';
import { cancelCaseAction, listCancelReasonsAction, transitionCaseAction } from '../server/actions';
import type { CaseDetail, CaseItem, CodedValue, TextTemplate, TransitionOp } from '../server/types';
import { ImagesTab } from './images/ImagesTab';
import { BlocksSlidesTab } from './material/BlocksSlidesTab';
import { MolecularTab } from './molecular/MolecularTab';
import { StainsTab } from './material/StainsTab';
import { PartsTab } from './PartsTab';
import { ReportTab } from './report/ReportTab';
import type { ReportApi } from './report/ReportEditor';
import { Chip, FailNotice, KIND_LABEL, STATUS, StatusLabel, UrgentChip, newKey, usePageShortcuts, When, type Fail, type Tone } from './common';

const PAGE_ID = 'staff.anatomic.case';
/** Forms Alt+S can submit: the part forms (T-19) and the Molecular tab form (T-22). */
const SAVE_FORMS = 'form[data-testid^="part-form-"], form[data-testid="molecular-form"]';
type TabId = 'overview' | 'parts' | 'blocks' | 'stains' | 'images' | 'molecular' | 'report';

/** allowed_actions → menu label. `work` = also needs anatomic.case.work in the browser (defence in depth; the API decides). The three report actions open the Report tab (T-21), whose buttons check anatomic.case.signout. */
const ACTIONS = [
  { op: 'accessionAnatomicCase', label: 'Accession', work: true },
  { op: 'startAnatomicProcessing', label: 'Start processing', work: true },
  { op: 'markAnatomicCaseReady', label: 'Mark ready', work: true },
  { op: 'signOutAnatomicCase', label: 'Sign out' },
  { op: 'startAnatomicCaseChange', label: 'Revise/Amend' },
  { op: 'createAnatomicAddendum', label: 'Add addendum' },
  { op: 'cancelAnatomicCase', label: 'Cancel case', work: true, danger: true },
] as const;
const LAB_TONE: Record<NonNullable<CaseItem['lab_status']>, Tone> = { pending: 'neutral', resulted: 'warning', verified: 'warning', approved: 'success', cancelled: 'neutral' };
const DONE: Record<TransitionOp, string> = { 'start-processing': 'Processing started', 'mark-ready': 'Marked ready for reporting' };

function Banners({ detail }: { detail: CaseDetail }) {
  const draft = detail.open_draft && detail.open_draft.kind !== 'initial' ? detail.open_draft : undefined;
  return (
    <>
      {detail.flags.profile_missing ? <Banner tone="warning" title="This test has no pathology profile. Defaults were used. Ask a lab manager to set it up in Pathology setup." /> : null}
      {detail.parts.filter((p) => p.specimen_state === 'rejected').map((p) => (
        <Banner key={p.id} tone="danger" title={`Specimen for part ${p.letter} was rejected in the lab. A recollected specimen will be linked here when received.`} />
      ))}
      {detail.items.filter((i) => !i.is_active).map((i) => (
        <Banner key={i.case_item_id} tone="danger" title={`${i.test_name} was removed from the order. Sign-out is blocked for this case until the order is corrected or the case is cancelled.`} />
      ))}
      {detail.items.filter((i) => i.is_active && i.role === 'addon' && !['resulted', 'verified', 'approved'].includes(i.lab_status ?? '')).map((i) => (
        <Banner key={i.case_item_id} tone="warning" title={`Billed add-on ${i.test_name} still needs a result (sign an addendum linked to it) or cancellation at front desk.`} />
      ))}
      {draft ? (
        <Banner tone="info" title={`A ${draft.kind} is in progress.`}>
          Last saved <When value={draft.updated_at} time />
        </Banner>
      ) : null}
    </>
  );
}

function Details({ detail }: { detail: CaseDetail }) {
  const p = detail.patient;
  return (
    <DescriptionList
      columns={3}
      items={[
        { term: 'Patient', value: p ? <>{p.display_name}<br />{p.age_text} / {p.sex} · {p.patient_code}</> : '—' },
        { term: 'Case kind', value: KIND_LABEL[detail.case_kind] ?? detail.case_kind },
        { term: 'Priority', value: detail.priority === 'urgent' ? <UrgentChip /> : 'Routine' },
        { term: 'Centre', value: <IdText value={detail.centre_id} /> },
        { term: 'Received', value: <When value={detail.received_at} time /> },
        { term: 'Accessioned', value: <When value={detail.accessioned_at} time /> },
        { term: 'Assigned pathologist', value: detail.assigned_pathologist?.display_name ?? '—' },
        {
          term: 'Tests',
          value: (
            <ul>
              {detail.items.map((i) => (
                <li key={i.case_item_id}>
                  {i.test_name}
                  {i.lab_status ? <> <Chip size="sm" tone={LAB_TONE[i.lab_status] ?? 'neutral'} label={`Lab: ${i.lab_status}`} /></> : null}
                </li>
              ))}
            </ul>
          ),
        },
        { term: 'Current version', value: detail.current_version_no > 0 ? String(detail.current_version_no) : 'None yet' },
      ]}
    />
  );
}

function Overview({ detail }: { detail: CaseDetail }) {
  return (
    <>
      {detail.clinical_history_text ? (
        <section aria-labelledby="anatomic-history">
          <h2 id="anatomic-history" className="lims-card-title">Clinical history</h2>
          <p>{detail.clinical_history_text}</p>
        </section>
      ) : null}
      <section aria-labelledby="anatomic-timeline">
        <h2 id="anatomic-timeline" className="lims-card-title">Status history</h2>
        <Timeline items={detail.transitions.map((t) => ({ at: t.at, label: STATUS[t.to_status]?.[1] ?? t.to_status, actor: t.by_display_name }))} />
      </section>
    </>
  );
}

export function CaseWorkspace({ detail, permissions, templates = [] }: { detail: CaseDetail; permissions: readonly string[]; templates?: readonly TextTemplate[] }) {
  const router = useRouter();
  const toast = useToast();
  const canWork = permissions.includes('anatomic.case.work');
  const canSign = permissions.includes('anatomic.case.signout');
  const allowed = ACTIONS.filter((a) => detail.allowed_actions.includes(a.op) && (!('work' in a) || !a.work || canWork));
  const can = (op: string) => allowed.some((a) => a.op === op);

  const [tab, setTab] = useState<TabId>('overview');
  const [signing, setSigning] = useState(false);
  const [leaving, setLeaving] = useState<TabId>();
  const reportApi = useRef<ReportApi | null>(null);
  /** Tab change; leaving the Report tab with unsaved edits asks first (04-UI-UX §2). */
  // The shortcut registry keeps the closures of the render that registered them, so the current tab is read from a ref, not from state.
  const tabRef = useRef<TabId>(tab);
  tabRef.current = tab;
  const go = (id: TabId) => {
    if (id === tabRef.current) return;
    if (tabRef.current === 'report' && reportApi.current?.isDirty()) return setLeaving(id);
    setSigning(false);
    setTab(id);
  };
  const [fail, setFail] = useState<Fail>();
  const [mfa, setMfa] = useState(false);
  const [accessioning, setAccessioning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reasons, setReasons] = useState<CodedValue[]>([]);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const lockedAt = useRef<number | undefined>(undefined);

  const report = (f: Fail) => (f.code === 'auth.mfa_required' ? setMfa(true) : setFail(f));
  const refreshed = () => router.refresh();

  usePageShortcuts(
    PAGE_ID,
    [
      { key: 'Alt+O', description: 'Overview tab', run: () => go('overview') },
      { key: 'Alt+G', description: 'Parts & gross tab', run: () => go('parts') },
      { key: 'Alt+B', description: 'Blocks & slides tab', run: () => go('blocks') },
      { key: 'Alt+T', description: 'Stains tab', run: () => go('stains') },
      { key: 'Alt+I', description: 'Images tab', run: () => go('images') },
      { key: 'Alt+R', description: 'Report tab', run: () => go('report') },
      {
        key: 'Alt+S',
        description: 'Save the form you are working in',
        run: () => {
          if (tabRef.current === 'report' && reportApi.current) return reportApi.current.save(); // the report draft (T-21)
          const forms = document.querySelectorAll<HTMLFormElement>(SAVE_FORMS);
          const mine = (document.activeElement as HTMLElement | null)?.closest?.(SAVE_FORMS) as HTMLFormElement | null;
          (mine ?? (forms.length === 1 ? forms[0] : null))?.requestSubmit();
        },
      },
      ...(can('accessionAnatomicCase') ? [{ key: 'Alt+A', description: 'Open the Accession dialog', run: () => setAccessioning(true) }] : []),
      ...(canWork ? [{ key: 'Alt+L', description: 'Open the labels page (blocks)', run: () => router.push(`/anatomic/cases/${detail.id}/labels?kind=blocks`) }] : []),
      ...(canSign ? [{ key: 'Alt+U', description: 'Open the Sign out dialog', run: () => { go('report'); setSigning(true); } }] : []),
    ],
    [can('accessionAnatomicCase'), canWork, canSign, detail.id],
  );

  useEffect(() => {
    lockedAt.current = undefined; // a refreshed case (new version) unlocks the stage buttons
  }, [detail.version]);

  useEffect(() => {
    if (!cancelling || reasons.length) return;
    listCancelReasonsAction().then((r) => r.ok && setReasons(r.data), () => undefined);
  }, [cancelling, reasons.length]);

  const transition = async (op: TransitionOp) => {
    if (inFlight.current || lockedAt.current === detail.version) return;
    inFlight.current = true;
    setPending(true);
    setFail(undefined);
    try {
      const r = await transitionCaseAction(detail.id, op, detail.version, newKey());
      if (r.ok) {
        lockedAt.current = detail.version; // one request per version: a second click before the refresh lands is ignored
        toast.show({ tone: 'success', title: DONE[op] });
        refreshed();
      } else report(r);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const confirmCancel = async ({ reasonCode, reasonText }: { reasonCode?: string; reasonText?: string }) => {
    const r = await cancelCaseAction(detail.id, detail.version, { reason_code: reasonCode ?? '', ...(reasonText ? { reason_text: reasonText } : {}) }, newKey());
    setCancelling(false);
    if (r.ok) {
      toast.show({ tone: 'success', title: 'Case cancelled' });
      refreshed();
    } else report(r);
  };

  const onAction = (op: string) => {
    if (op === 'accessionAnatomicCase') setAccessioning(true);
    else if (op === 'startAnatomicProcessing') void transition('start-processing');
    else if (op === 'markAnatomicCaseReady') void transition('mark-ready');
    else if (op === 'cancelAnatomicCase') setCancelling(true);
    else if (op === 'signOutAnatomicCase') {
      go('report');
      setSigning(true);
    } else if (op === 'startAnatomicCaseChange' || op === 'createAnatomicAddendum') go('report'); // the buttons of the Report tab do the rest
  };

  const stage = can('accessionAnatomicCase')
    ? { label: 'Accession', press: () => setAccessioning(true) }
    : can('startAnatomicProcessing')
      ? { label: 'Start processing', press: () => void transition('start-processing') }
      : can('markAnatomicCaseReady')
        ? { label: 'Mark ready for reporting', press: () => void transition('mark-ready') }
        : undefined;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' }, { id: 'parts', label: 'Parts & gross' }, { id: 'blocks', label: 'Blocks & slides' }, { id: 'stains', label: 'Stains' }, { id: 'images', label: 'Images' },
    ...(detail.case_kind === 'molecular' ? [{ id: 'molecular' as const, label: 'Molecular' }] : []),
    { id: 'report', label: 'Report' },
  ];
  const accession = detail.accession_no;

  return (
    <>
      <PageHeader
        title={accession ?? 'Not accessioned'}
        helpKey="anatomic.case"
        breadcrumbs={[{ label: 'Pathology cases', href: '/anatomic' }, { label: accession ?? 'Case' }]}
        status={<StatusLabel status={detail.status} />}
        actions={
          <>
            {allowed.length ? (
              <Menu
                trigger={<Button>Actions</Button>}
                items={allowed.map((a) => ({ id: a.op, label: a.label, ...('danger' in a ? { isDanger: true } : {}) }))}
                onAction={onAction}
              />
            ) : null}
            {stage ? <Button variant="primary" isLoading={pending} onPress={stage.press}>{stage.label}</Button> : null}
          </>
        }
      />
      <Banners detail={detail} />
      <FailNotice fail={fail} status={detail.status} />
      <Details detail={detail} />
      <Tabs aria-label="Case sections" items={tabs} selectedId={tab} onChange={(id) => go(id as TabId)}>
        {tab === 'overview' ? <Overview detail={detail} /> : null}
        {tab === 'parts' ? <PartsTab detail={detail} canWork={canWork} templates={templates} onFail={report} onMfa={() => setMfa(true)} /> : null}
        {tab === 'blocks' ? <BlocksSlidesTab detail={detail} canWork={canWork} onFail={report} onMfa={() => setMfa(true)} /> : null}
        {tab === 'stains' ? <StainsTab detail={detail} canWork={canWork} onFail={report} onMfa={() => setMfa(true)} /> : null}
        {tab === 'images' ? <ImagesTab detail={detail} canWork={canWork} onFail={report} onMfa={() => setMfa(true)} /> : null}
        {tab === 'molecular' ? <MolecularTab detail={detail} canWork={canWork} onFail={report} onMfa={() => setMfa(true)} /> : null}
        {tab === 'report' ? <ReportTab detail={detail} canWork={canWork} canSign={canSign} templates={templates} signing={signing} onSigning={setSigning} apiRef={reportApi} onMfa={() => setMfa(true)} /> : null}
      </Tabs>
      <Dialog
        title="Discard unsaved changes?"
        size="sm"
        isOpen={leaving !== undefined}
        onClose={() => setLeaving(undefined)}
        footer={
          <>
            <Button variant="ghost" onPress={() => setLeaving(undefined)}>Stay</Button>
            <Button variant="danger" onPress={() => { setSigning(false); setTab(leaving!); setLeaving(undefined); }}>Discard</Button>
          </>
        }
      >
        <p>The report draft has changes that are not saved. Leaving the Report tab loses them.</p>
      </Dialog>

      {can('accessionAnatomicCase') ? (
        <AccessionDialog key={detail.version} detail={detail} isOpen={accessioning} onClose={() => setAccessioning(false)} onMfa={() => setMfa(true)} onDone={() => { setAccessioning(false); refreshed(); }} />
      ) : null}
      <ConfirmDialog
        title="Cancel case"
        tone="danger"
        confirmLabel="Cancel case"
        isOpen={cancelling}
        onCancel={() => setCancelling(false)}
        body={reasons.length ? 'Cancelling stops all work on this case. Choose a reason.' : 'Cancelling stops all work on this case. No cancel reasons are set up yet; ask an administrator.'}
        requireReason={{ codedSet: 'anatomic.cancel_reasons', options: reasons, freeText: { maxLength: 500, isRequired: false } }}
        onConfirm={confirmCancel}
      />
      <Dialog
        title="Verify your identity"
        size="sm"
        isOpen={mfa}
        onClose={() => setMfa(false)}
        footer={
          <>
            <Button variant="ghost" onPress={() => setMfa(false)}>Cancel</Button>
            {/* ponytail: no C2 step-up route is known (same as C9 ExportDialog); reload lets the session guard redirect to it, then the user repeats the action. */}
            <Button variant="primary" onPress={() => window.location.reload()}>Verify now</Button>
          </>
        }
      >
        <p>This action needs two-factor verification.</p>
      </Dialog>
    </>
  );
}
