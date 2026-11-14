'use client';
// 04-UI-UX §4.2.7 Report draft editor (R2): Gross (insert from parts), Microscopy, Diagnosis / impression, Comment, Synoptic, Ancillary results, Slide assessments, Images,
// Abnormal flag, Critical finding, Diagnosis codes, a live Preview, [Save draft] (Alt+S) and the primary [Sign out] (Alt+U). One kit Form; drafts save without completeness checks
// (only sign-out checks, on the server): [Save draft] and Ctrl+Enter call the save directly, so an empty required synoptic field never blocks a draft.
// Sign-out flow (03-APP-FLOW §4.2): 1 save unsaved edits first, 2 POST sign-out with If-Match = the draft version; 422 anatomic.report_incomplete -> the kit ErrorSummary through
// Form `problem` (one link per JSON Pointer that maps to a field); 403 auth.mfa_required -> the step-up dialog of the page, nothing is lost. Text is text, never HTML (REQ-SEC-088).
// LD-140 (2026-11-13, binding): kit components and token class names only; one primary button on the page ([Sign out]); every status shows tone, icon and word.
import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Form } from '@lims/ui/components/Form';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { discardChangeAction, saveReportDraftAction, signOutAction } from '../../server/actions.report';
import type { Definition } from '../../server/config.types';
import type { DiagnosisCode, ReportDraft, ReportDraftInput } from '../../server/report.types';
import type { CaseDetail, TextTemplate } from '../../server/types';
import { Chip, newKey, partName, When, type Fail } from '../common';
import { DiagnosisPicker } from './DiagnosisPicker';
import { ImagePicker } from './ImagePicker';
import { ReportPreview } from './ReportPreview';
import { INCOMPLETE, mapIncomplete } from './reportCopy';
import { SignOutDialog } from './SignOutDialog';
import { SynopticSection, sendableValues, type Definitions, type SynInstance } from './SynopticForm';

/** The page reaches the editor through this (Alt+S, the unsaved-changes guard of the tabs). */
export interface ReportApi { save: () => void; isDirty: () => boolean }
type Flag = 'none' | 'N' | 'A';
interface State {
  gross: string; microscopy: string; impression: string; comment: string; flag: Flag; critical: boolean;
  synoptic: SynInstance[]; imageIds: string[]; ancillary: Record<string, string>; codes: DiagnosisCode[];
}
type Section = 'gross' | 'microscopy';
const MAX = { gross: 20000, microscopy: 20000, impression: 8000, comment: 8000, ancillary: 2000 } as const;
const CODE_AT_END = /;([a-z0-9_]{1,16})$/;
const KIND_LABEL = { initial: 'Initial report', revision: 'Revision', amendment: 'Amendment' } as const;

const fromDraft = (d: ReportDraft): State => ({
  gross: d.gross_text, microscopy: d.microscopy_text, impression: d.impression_text, comment: d.comment_text, flag: d.flag ?? 'none', critical: d.is_critical,
  synoptic: d.synoptic.map((s) => ({ ...s, values: { ...s.values } })), imageIds: [...d.image_ids], ancillary: Object.fromEntries(d.ancillary.map((a) => [a.stain_order_id, a.result_text])), codes: [...d.diagnosis_codes],
});

export function ReportEditor({ detail, draft, initialDefs, canWork, canSignOut, templates, maxImages, reasonDisplay, signing, onSigning, apiRef, onFail, onMfa }: {
  detail: CaseDetail; draft: ReportDraft; initialDefs: Definitions; canWork: boolean; canSignOut: boolean; templates: readonly TextTemplate[]; maxImages: number;
  reasonDisplay: (code: string | undefined) => string | undefined; signing: boolean; onSigning: (open: boolean) => void; apiRef: MutableRefObject<ReportApi | null>;
  onFail: (f: Fail | undefined) => void; onMfa: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState<State>(() => fromDraft(draft));
  const [defs, setDefs] = useState<Definitions>(initialDefs);
  const [pending, setPending] = useState(false);
  const [hint, setHint] = useState<string>();
  const [replacing, setReplacing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [problem, setProblem] = useState<{ errors: { path?: string; code?: string; message: string }[] }>();
  const version = useRef(draft.version);
  const saving = useRef(false);
  const patch = (p: Partial<State>) => setS((x) => ({ ...x, ...p }));

  const completed = detail.stain_orders.filter((o) => o.status === 'completed');
  const stainLabel = (o: (typeof completed)[number]) => `${o.stain_display} on ${o.block_label ?? partName(detail.parts, o.part_id)}`;
  const toInput = (): ReportDraftInput => ({
    gross_text: s.gross, microscopy_text: s.microscopy, impression_text: s.impression, comment_text: s.comment,
    ...(s.flag === 'none' ? {} : { flag: s.flag }), is_critical: s.critical,
    synoptic: s.synoptic.map((i) => ({ template_id: i.template_id, values: sendableValues(defs[i.template_id], i.values) })),
    image_ids: s.imageIds,
    ancillary: completed.flatMap((o) => (s.ancillary[o.id]?.trim() ? [{ stain_order_id: o.id, result_text: s.ancillary[o.id]! }] : [])),
    diagnosis_codes: s.codes.map((c) => ({ code: c.code })),
  });
  const [saved, setSaved] = useState(() => JSON.stringify(toInput()));
  const dirty = JSON.stringify(toInput()) !== saved;

  const report = (f: Fail) => (f.code === 'auth.mfa_required' ? onMfa() : onFail(f));

  /** R2 (no Idempotency-Key). Returns the saved draft, or undefined when nothing was saved (failure already shown). */
  const save = async (quiet = false): Promise<ReportDraft | undefined> => {
    if (saving.current || !canWork) return undefined;
    saving.current = true;
    setPending(true);
    onFail(undefined);
    setProblem(undefined);
    const body = toInput();
    try {
      const r = await saveReportDraftAction(detail.id, version.current, body);
      if (!r.ok) return void report(r);
      version.current = r.data.version;
      setSaved(JSON.stringify(body));
      if (!quiet) toast.show({ tone: 'success', title: 'Draft saved' });
      return r.data;
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  // A double click on [Save draft] sends one request: a second press within half a second with nothing changed since the first is ignored (the keyboard saves are not debounced).
  const pressed = useRef({ at: 0, json: '' });
  const press = () => {
    const now = Date.now();
    const json = JSON.stringify(toInput());
    if (now - pressed.current.at < 500 && json === pressed.current.json) return;
    pressed.current = { at: now, json };
    void save();
  };

  apiRef.current = { save: () => void save(), isDirty: () => dirty };
  useEffect(() => () => { apiRef.current = null; }, [apiRef]);

  /** R5: drop the open revision / amendment draft; the signed version stays on record. */
  const discard = async () => {
    const r = await discardChangeAction(detail.id, version.current, newKey());
    setDiscarding(false);
    if (r.ok) {
      toast.show({ tone: 'success', title: 'Change discarded' });
      router.refresh();
    } else report(r);
  };

  const busy = useRef(false);
  /** Flow steps 1-2: save unsaved edits first, then sign out. */
  const signOut = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      onFail(undefined);
      setProblem(undefined);
      let v = version.current;
      if (dirty) {
        const d = await save(true);
        if (!d) return onSigning(false); // a failing save stops the sign-out; the failure is on screen
        v = d.version;
      }
      const r = await signOutAction(detail.id, v, newKey());
      onSigning(false);
      if (r.ok) {
        toast.show({ tone: 'success', title: `Signed out as version ${r.data.report_version.version_no}. Sent to lab verification.` });
        router.refresh();
      } else if (r.code === 'auth.mfa_required') onMfa();
      else {
        if (r.code === INCOMPLETE) {
          const sent = toInput();
          setProblem({
            errors: mapIncomplete(r.errors, {
              synoptic: s.synoptic.map((i) => ({ title: i.title, labels: Object.fromEntries((defs[i.template_id]?.sections ?? []).flatMap((x) => x.fields).map((f) => [f.key, f.label])) })),
              ancillary: sent.ancillary.map((a) => ({ id: a.stain_order_id, label: stainLabel(completed.find((o) => o.id === a.stain_order_id)!) })),
            }),
          });
        }
        onFail(r);
      }
    } finally {
      busy.current = false;
    }
  };

  // `;code` + Tab expands the matching ACTIVE template of THIS section (client side, 04-UI-UX §2, AC-07.2); unknown code -> hint, text unchanged.
  const expand = (section: Section) => (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target;
    if (e.key !== 'Tab' || e.shiftKey || e.nativeEvent.isComposing || !(el instanceof HTMLTextAreaElement)) return;
    const caret = el.selectionStart ?? el.value.length;
    const m = CODE_AT_END.exec(el.value.slice(0, caret));
    if (!m) return;
    const tpl = templates.find((t) => t.is_active && t.section === section && t.short_code === m[1]);
    if (!tpl) return setHint(`No template ;${m[1]}`);
    e.preventDefault();
    setHint(undefined);
    patch({ [section]: (el.value.slice(0, caret - m[0].length) + tpl.body + el.value.slice(caret)).slice(0, MAX[section]) });
  };

  const grossFromParts = detail.parts.filter((p) => p.gross?.gross_text).map((p) => `Part ${p.letter}: ${p.gross!.gross_text}`).join('\n\n').slice(0, MAX.gross);
  const insertGross = () => (s.gross.trim() ? setReplacing(true) : patch({ gross: grossFromParts }));

  // Ctrl+Enter saves like [Save draft] (the kit Form shortcut would run the completeness checks of the fields first).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canWork) {
      e.preventDefault();
      void save();
    }
  };

  const ro = !canWork;
  const histology = detail.case_kind === 'histology';
  const activeTests = detail.items.filter((i) => i.is_active).map((i) => i.test_name);
  const reason = reasonDisplay(draft.change_reason_code);
  const kind = draft.kind === 'amendment' ? `Amendment — reason: ${reason ?? draft.change_reason_code ?? 'not stated'}` : KIND_LABEL[draft.kind];
  const included = detail.slides.filter((x) => x.include_in_report);
  const readyImages = detail.images.filter((i) => i.is_active && i.state === 'ready');

  return (
    <>
      <p>
        <Chip tone={draft.kind === 'amendment' ? 'warning' : 'info'} label={kind} />
        {draft.kind === 'revision' && reason ? <> <span className="lims-description">Reason: {reason}</span></> : null}
      </p>
      <p className="lims-description">Last saved <When value={draft.updated_at} time /> by {draft.updated_by_display_name}</p>
      <Form onSubmit={() => void save()} submitShortcut={false} errorSummary {...(problem ? { problem } : {})} data-testid="report-form">
        <div onKeyDown={onKey}>
          <div onKeyDown={expand('gross')}>
            <TextArea label={histology ? 'Gross (required)' : 'Gross'} name="gross_text" rows={8} maxLength={MAX.gross} showCount isReadOnly={ro} value={s.gross} onChange={(v) => { patch({ gross: v }); setHint(undefined); }} />
          </div>
          {ro ? null : <Button variant="ghost" onPress={insertGross}>Insert gross from parts</Button>}
          <div onKeyDown={expand('microscopy')}>
            <TextArea label="Microscopy" name="microscopy_text" rows={6} maxLength={MAX.microscopy} showCount isReadOnly={ro} value={s.microscopy} onChange={(v) => { patch({ microscopy: v }); setHint(undefined); }} />
          </div>
          {hint ? <p className="lims-description" role="status">{hint}</p> : null}
          <TextArea label="Diagnosis / impression (required)" name="impression_text" rows={5} maxLength={MAX.impression} showCount isReadOnly={ro} value={s.impression} onChange={(v) => patch({ impression: v })} />
          <TextArea label="Comment" name="comment_text" rows={3} maxLength={MAX.comment} showCount isReadOnly={ro} value={s.comment} onChange={(v) => patch({ comment: v })} />

          <SynopticSection kind={detail.case_kind} instances={s.synoptic} defs={defs} readOnly={ro} onChange={(synoptic) => patch({ synoptic })} onDef={(id, def: Definition) => setDefs((d) => ({ ...d, [id]: def }))} onFail={report} />

          <section aria-labelledby="report-ancillary">
            <h3 id="report-ancillary" className="lims-card-title">Ancillary results</h3>
            {completed.length === 0 ? <p className="lims-description">No completed special stains or IHC yet.</p> : null}
            {completed.map((o) => (
              <TextArea key={o.id} label={stainLabel(o)} name={`ancillary_${o.id}`} rows={3} maxLength={MAX.ancillary} showCount isReadOnly={ro} value={s.ancillary[o.id] ?? ''} onChange={(v) => patch({ ancillary: { ...s.ancillary, [o.id]: v } })} />
            ))}
          </section>

          <section aria-labelledby="report-slides">
            <h3 id="report-slides" className="lims-card-title">Slide assessments</h3>
            {included.length === 0 ? <p className="lims-description">No slides are included in the report.</p> : null}
            <ul>{included.map((x) => <li key={x.id}>{x.label}{x.finding_text ? ` — ${x.finding_text}` : ''}</li>)}</ul>
          </section>

          <ImagePicker images={detail.images} selected={s.imageIds} max={maxImages} readOnly={ro} onChange={(imageIds) => patch({ imageIds })} />

          <RadioGroup<Flag>
            label="Overall result" name="flag" orientation="horizontal" isReadOnly={ro} value={s.flag} onChange={(flag) => patch({ flag })}
            options={[{ value: 'N', label: 'Normal' }, { value: 'A', label: 'Abnormal' }, { value: 'none', label: 'Not stated' }]}
          />
          <Checkbox label="Critical or unexpected finding (notify per lab protocol)" name="is_critical" isSelected={s.critical} isDisabled={ro} onChange={(critical) => patch({ critical })} />

          <DiagnosisPicker codes={s.codes} readOnly={ro} onChange={(codes) => patch({ codes })} />

          {ro ? null : (
            <div>
              <Button isLoading={pending} shortcut="Alt+S" onPress={press}>Save draft</Button>
              {draft.kind !== 'initial' ? <Button variant="ghost" onPress={() => setDiscarding(true)}>Discard change</Button> : null}
              {canSignOut ? <Button variant="primary" onPress={() => onSigning(true)}>Sign out</Button> : null}
            </div>
          )}
        </div>
      </Form>

      <ReportPreview
        data={{
          gross: s.gross, microscopy: s.microscopy, impression: s.impression, comment: s.comment, synoptic: s.synoptic, defs,
          ancillary: completed.flatMap((o) => (s.ancillary[o.id]?.trim() ? [{ label: stainLabel(o), text: s.ancillary[o.id]! }] : [])),
          slides: included, images: s.imageIds.flatMap((id) => readyImages.filter((i) => i.id === id)), codes: s.codes,
        }}
      />

      <SignOutDialog isOpen={signing && canSignOut} versionNo={detail.current_version_no + 1} tests={activeTests} critical={s.critical} kindLabel={kind} onCancel={() => onSigning(false)} onConfirm={signOut} />
      <ConfirmDialog
        title="Discard this change?"
        tone="danger"
        confirmLabel="Discard change"
        isOpen={discarding}
        onCancel={() => setDiscarding(false)}
        body="The draft is deleted. The signed version stays on record."
        onConfirm={discard}
      />
      <ConfirmDialog
        title="Replace Gross text?"
        confirmLabel="Replace"
        isOpen={replacing}
        onCancel={() => setReplacing(false)}
        body="The Gross text is replaced by the gross description of each part. Nothing is saved until you save the draft."
        onConfirm={() => { patch({ gross: grossFromParts }); setReplacing(false); }}
      />
    </>
  );
}
