'use client';
// 04-UI-UX §4.2.7 Report tab. Before the first sign-out (or while a revision / amendment draft is open): the draft editor (R1 load, 404 = "No report draft yet." + [Start report]).
// After sign-out with no open change draft: the version viewer, [Revise] / [Amend] and the addenda. Failures show here in one alert with the §8 copy (never a raw code or server
// detail); 403 auth.mfa_required opens the page's step-up dialog and changes nothing. LD-140 (2026-11-13, binding): kit components and token class names only.
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';
import { getMaxReportImagesAction, getReportDraftAction, getSynopticTemplateAction, listAmendmentReasonsAction, saveReportDraftAction } from '../../server/actions.report';
import type { Definition } from '../../server/config.types';
import type { ReasonOption, ReportDraft } from '../../server/report.types';
import type { CaseDetail, TextTemplate } from '../../server/types';
import { FailNotice, type Fail } from '../common';
import { ChangeDialog } from './ChangeDialog';
import { ReportEditor, type ReportApi } from './ReportEditor';
import { reportDescribe } from './reportCopy';
import { VersionViewer } from './VersionViewer';

const DEFAULT_MAX_IMAGES = 24; // contracts: ReportDraftInput.image_ids maxItems
type Load = { s: 'loading' } | { s: 'none' } | { s: 'failed' } | { s: 'ready'; draft: ReportDraft; defs: Record<string, Definition>; maxImages: number };

export function ReportTab({ detail, canWork, canSign, templates, signing, onSigning, apiRef, onMfa }: {
  detail: CaseDetail; canWork: boolean; canSign: boolean; templates: readonly TextTemplate[]; signing: boolean; onSigning: (open: boolean) => void;
  apiRef: MutableRefObject<ReportApi | null>; onMfa: () => void;
}) {
  const viewer = detail.current_version_no > 0 && !detail.open_draft;
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [fail, setFail] = useState<Fail>();
  const [reasons, setReasons] = useState<ReasonOption[]>();
  const [reasonsFailed, setReasonsFailed] = useState(false);
  const [changing, setChanging] = useState(false);
  const [starting, setStarting] = useState(false);
  const maxImages = useRef(DEFAULT_MAX_IMAGES);

  const onFail = (f: Fail | undefined) => (f?.code === 'auth.mfa_required' ? onMfa() : setFail(f));
  const can = (op: string) => detail.allowed_actions.includes(op);

  // R1 + the definitions of the saved synoptic instances (each from ITS template version) + settings.max_report_images, before the editor shows.
  useEffect(() => {
    if (viewer) return;
    let live = true;
    setLoad({ s: 'loading' });
    const fetchAll = async () => {
      const [r, st] = await Promise.all([getReportDraftAction(detail.id), getMaxReportImagesAction()]);
      if (!live) return;
      maxImages.current = st.ok ? st.data : DEFAULT_MAX_IMAGES;
      if (!r.ok) {
        if (r.status === 404) return setLoad({ s: 'none' });
        setFail(r);
        return setLoad({ s: 'failed' });
      }
      const ids = [...new Set(r.data.synoptic.map((x) => x.template_id))];
      const found = await Promise.all(ids.map((id) => getSynopticTemplateAction(id)));
      if (!live) return;
      const defs: Record<string, Definition> = {};
      found.forEach((t, i) => (t.ok ? (defs[ids[i]!] = t.data.definition) : setFail(t)));
      setLoad({ s: 'ready', draft: r.data, defs, maxImages: maxImages.current });
    };
    // a transport failure (not an API problem) throws out of the action: the generic message, never an unhandled rejection
    fetchAll().catch(() => {
      if (!live) return;
      setFail({ ok: false, status: 502, code: 'common.internal' });
      setLoad({ s: 'failed' });
    });
    return () => { live = false; };
  }, [detail.id, viewer]);

  // The C5 amendment reasons give the reason display (badge, Versions table) and the options of the change dialog.
  const draftReason = load.s === 'ready' ? load.draft.change_reason_code : undefined;
  useEffect(() => {
    if (reasons || (!viewer && !draftReason)) return;
    void listAmendmentReasonsAction().then((r) => (r.ok ? setReasons(r.data) : setReasonsFailed(true)));
  }, [viewer, draftReason, reasons]);
  const reasonDisplay = (code: string | undefined) => (code ? reasons?.find((x) => x.code === code)?.display : undefined);

  const draftKind = load.s === 'ready' ? load.draft.kind : undefined;
  const canSignOut = canSign && !viewer && (can('signOutAnatomicCase') || (draftKind !== undefined && draftKind !== 'initial'));
  useEffect(() => {
    if (signing && (viewer || (load.s !== 'loading' && !canSignOut))) onSigning(false); // Alt+U / the menu item with nothing to sign
  }, [signing, viewer, load.s, canSignOut, onSigning]);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setFail(undefined);
    try {
      const r = await saveReportDraftAction(detail.id, 0, { gross_text: '', microscopy_text: '', impression_text: '', comment_text: '', is_critical: false, synoptic: [], image_ids: [], ancillary: [], diagnosis_codes: [] });
      if (r.ok) setLoad({ s: 'ready', draft: r.data, defs: {}, maxImages: maxImages.current });
      else onFail(r);
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <FailNotice fail={fail} status={detail.status} describe={reportDescribe(detail.items, load.s === 'ready' ? load.maxImages : maxImages.current)} />
      {viewer ? (
        <>
          <VersionViewer detail={detail} canWork={canWork} canSignOut={canSign} reasonDisplay={reasonDisplay} onChange={() => setChanging(true)} onFail={onFail} onMfa={onMfa} />
          <ChangeDialog detail={detail} reasons={reasons ?? []} reasonsFailed={reasonsFailed} isOpen={changing} onClose={() => setChanging(false)} onFail={onFail} onMfa={onMfa} />
        </>
      ) : load.s === 'loading' ? (
        <LoadingSkeleton variant="form" />
      ) : load.s === 'none' ? (
        <EmptyState title="No report draft yet." body={canWork ? 'Start a report to write the gross, microscopy and diagnosis.' : 'A pathologist starts the report.'} {...(canWork ? { action: { label: 'Start report', onPress: () => void start() } } : {})} />
      ) : load.s === 'ready' ? (
        <ReportEditor
          detail={detail} draft={load.draft} initialDefs={load.defs} canWork={canWork} canSignOut={canSignOut} templates={templates} maxImages={load.maxImages}
          reasonDisplay={reasonDisplay} signing={signing} onSigning={onSigning} apiRef={apiRef} onFail={onFail} onMfa={onMfa}
        />
      ) : null}
    </>
  );
}
