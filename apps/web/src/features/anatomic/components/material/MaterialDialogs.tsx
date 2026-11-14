'use client';
// 04-UI-UX §4.2.3 dialogs of the Blocks & slides tab: [Add blocks], [Add slides] / [Add slides from part], cytology slide assessment (Drawer).
// Client checks (required, 1-50 / 1-20, lengths) are hints; the API re-checks everything (REQ-SEC-081). Each write carries its own Idempotency-Key.
// LD-140 (2026-11-13, binding): kit components only; server text is rendered as text, never HTML (REQ-SEC-088).
import { useState } from 'react';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { addBlocksAction, addSlidesAction, saveAssessmentAction } from '../../server/actions.material';
import type { CaseDetail, CodedValue, Slide } from '../../server/types';
import { newKey } from '../common';
import { FormDialog } from './FormDialog';
import { useStains } from './useStains';

interface Shared { detail: CaseDetail; onClose: () => void; onMfa: () => void; onDone: () => void }

const partOptions = (detail: CaseDetail) => detail.parts.map((p) => ({ value: p.id, label: `Part ${p.letter}${p.site_text ? ` — ${p.site_text}` : ''}` }));
const countValue = (n: number | undefined) => (n !== undefined ? { value: n } : {});

export function AddBlocksDialog({ detail, onClose, onMfa, onDone }: Shared) {
  const [part, setPart] = useState<string>();
  const [count, setCount] = useState<number | undefined>(1);
  const [note, setNote] = useState('');
  return (
    <FormDialog
      title="Add blocks"
      submitLabel="Add blocks"
      status={detail.status}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!part || count === undefined) return undefined;
        const r = await addBlocksAction(detail.id, { part_id: part, count, ...(note ? { note } : {}) }, newKey());
        if (r.ok) onDone();
        else return r;
        return undefined;
      }}
    >
      <Select label="Part (required)" placeholder="Part: none chosen" name="part_id" isRequired options={partOptions(detail)} {...(part ? { value: part } : {})} onChange={setPart} />
      <IntegerField label="Count" name="count" min={1} max={50} isRequired {...countValue(count)} onChange={setCount} />
      <TextField label="Note" name="note" maxLength={200} value={note} onChange={setNote} />
    </FormDialog>
  );
}

/** One block chosen → block_id; no block (cytology / histology without blocks) → part_id. Exactly one of the two goes to the API. */
export function AddSlidesDialog({ detail, blockId, onClose, onMfa, onDone }: Shared & { blockId?: string }) {
  const stains = useStains();
  const [part, setPart] = useState<string>();
  const [stain, setStain] = useState<string>();
  const [count, setCount] = useState<number | undefined>(1);
  const block = blockId ? detail.blocks.find((b) => b.id === blockId) : undefined;
  return (
    <FormDialog
      title={block ? `Add slides to ${block.label}` : 'Add slides from part'}
      submitLabel="Add slides"
      status={detail.status}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!stain || count === undefined || (!blockId && !part)) return undefined;
        const where = blockId ? { block_id: blockId } : { part_id: part! };
        const r = await addSlidesAction(detail.id, { ...where, stain_code: stain, count }, newKey());
        if (r.ok) onDone();
        else return r;
        return undefined;
      }}
    >
      {blockId ? null : <Select label="Part (required)" placeholder="Part: none chosen" name="part_id" isRequired options={partOptions(detail)} {...(part ? { value: part } : {})} onChange={setPart} />}
      <Select label="Stain (required)" placeholder="Stain: none chosen" name="stain_code" isRequired options={stains.map((s) => ({ value: s.code, label: s.display }))} {...(stain ? { value: stain } : {})} onChange={setStain} />
      <IntegerField label="Count" name="count" min={1} max={20} isRequired {...countValue(count)} onChange={setCount} />
    </FormDialog>
  );
}

/** Cytology slide assessment (Drawer): Adequacy (optional), Finding (≤ 2000), Include in report (default off). PUT with the slide's version in If-Match. */
export function AssessmentDrawer({ detail, slide, adequacy, onClose, onMfa, onDone }: Shared & { slide: Slide; adequacy: readonly CodedValue[] }) {
  const [code, setCode] = useState<string | undefined>(slide.adequacy_code);
  const [finding, setFinding] = useState(slide.finding_text ?? '');
  const [include, setInclude] = useState(slide.include_in_report);
  return (
    <FormDialog
      as="drawer"
      title={`Assessment — ${slide.label}`}
      submitLabel="Save"
      status={detail.status}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        const r = await saveAssessmentAction(slide.id, slide.version, { ...(code ? { adequacy_code: code } : {}), ...(finding ? { finding_text: finding } : {}), include_in_report: include });
        if (r.ok) onDone();
        else return r;
        return undefined;
      }}
    >
      <Select label="Adequacy" name="adequacy_code" options={adequacy.map((a) => ({ value: a.code, label: a.display }))} {...(code ? { value: code } : {})} onChange={setCode} />
      <TextArea label="Finding" name="finding_text" maxLength={2000} rows={6} value={finding} onChange={setFinding} />
      <Checkbox label="Include in report" isSelected={include} onChange={setInclude} />
    </FormDialog>
  );
}
