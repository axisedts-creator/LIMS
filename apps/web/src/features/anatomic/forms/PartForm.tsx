'use client';
// 04-UI-UX §4.2.2 one Card per part: Site, Description, Gross description (plain text, showCount, ≤ 20000, `;code` + Tab template expansion),
// Pieces, Length/Width/Depth, Weight (g), Gross complete, Gross images. [Save part] (Alt+S) saves the part row and/or the gross record, only what changed.
// LD-140 (2026-11-13): kit components only; no hex colours, pixel radii or inline style objects. Narrative text is rendered as text, never HTML (REQ-SEC-088).
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { saveGrossAction, updatePartAction, uploadGrossImageAction } from '../server/actions';
import type { CaseStatus, GrossInput, Part, TextTemplate } from '../server/types';
import { failText, newKey, When, type Fail } from '../components/common';

const MAX_GROSS = 20000;
const DIM_ORDER = 'Fill the dimensions left to right: Length, then Width, then Depth.';
const CODE_AT_END = /;([a-z0-9_]{1,16})$/;

export interface PartFormProps {
  caseId: string;
  caseStatus: CaseStatus;
  part: Part;
  templates: readonly TextTemplate[];
  onFail: (f: Fail) => void;
  onMfa: () => void;
}

/** Read-only view for people without anatomic.case.work: values only, no controls. */
export function PartReadOnly({ part }: { part: Part }) {
  const g = part.gross;
  return (
    <div role="group" aria-label={`Part ${part.letter}${part.site_text ? ` — ${part.site_text}` : ''}`}>
      <Card title={`Part ${part.letter}${part.site_text ? ` — ${part.site_text}` : ''}`}>
        {part.description_text ? <p>{part.description_text}</p> : null}
        {g ? (
          <>
            <p>{g.gross_text}</p>
            <p>
              Pieces {g.pieces_count ?? '—'} · Dimensions {g.dimensions_mm?.join(' × ') ?? '—'} mm · Weight {g.weight_g ?? '—'} g · Gross complete: {g.is_complete ? 'Yes' : 'No'}
            </p>
            <p className="lims-description">Grossed by {g.grossed_by_display_name}, <When value={g.updated_at} time /></p>
          </>
        ) : (
          <p className="lims-description">No gross description yet.</p>
        )}
      </Card>
    </div>
  );
}

export function PartForm({ caseId, caseStatus, part, templates, onFail, onMfa }: PartFormProps) {
  const router = useRouter();
  const toast = useToast();
  // Last-known server rows; replaced by the save responses so a second save sends the new If-Match.
  const [base, setBase] = useState({ part, gross: part.gross });
  useEffect(() => setBase({ part, gross: part.gross }), [part]);
  const g = base.gross;

  const [site, setSite] = useState(part.site_text ?? '');
  const [description, setDescription] = useState(part.description_text ?? '');
  const [text, setText] = useState(g?.gross_text ?? '');
  const [pieces, setPieces] = useState<number | undefined>(g?.pieces_count);
  const [length, setLength] = useState<string | undefined>(g?.dimensions_mm?.[0]);
  const [width, setWidth] = useState<string | undefined>(g?.dimensions_mm?.[1]);
  const [depth, setDepth] = useState<string | undefined>(g?.dimensions_mm?.[2]);
  const [weight, setWeight] = useState<string | undefined>(g?.weight_g);
  const [complete, setComplete] = useState(g?.is_complete ?? false);
  const [dimError, setDimError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const [pending, setPending] = useState(false);

  const dirtyPart = site !== (base.part.site_text ?? '') || description !== (base.part.description_text ?? '');
  const dirtyGross =
    text !== (g?.gross_text ?? '') || pieces !== g?.pieces_count || (length ?? '') !== (g?.dimensions_mm?.[0] ?? '') || (width ?? '') !== (g?.dimensions_mm?.[1] ?? '') ||
    (depth ?? '') !== (g?.dimensions_mm?.[2] ?? '') || (weight ?? '') !== (g?.weight_g ?? '') || complete !== (g?.is_complete ?? false);

  const fail = (f: Fail) => (f.code === 'auth.mfa_required' ? onMfa() : onFail(f));

  const save = async () => {
    const dims = [length, width, depth].map((d) => d ?? '');
    if ((dims[2] && !dims[1]) || (dims[1] && !dims[0])) return setDimError(DIM_ORDER);
    setDimError(undefined);
    if (!dirtyPart && !dirtyGross) return toast.show({ tone: 'info', title: 'No changes to save' });
    setPending(true);
    try {
      if (dirtyPart) {
        const r = await updatePartAction(caseId, part.id, base.part.version, { site_text: site, ...(description ? { description_text: description } : {}) });
        if (!r.ok) return fail(r);
        setBase((b) => ({ ...b, part: r.data }));
      }
      if (dirtyGross) {
        const filled = dims.filter(Boolean);
        const input: GrossInput = {
          gross_text: text,
          ...(pieces !== undefined ? { pieces_count: pieces } : {}),
          ...(filled.length ? { dimensions_mm: filled } : {}),
          ...(weight ? { weight_g: weight } : {}),
          is_complete: complete,
        };
        const r = await saveGrossAction(caseId, part.id, g?.version ?? 0, input);
        if (!r.ok) return fail(r);
        setBase((b) => ({ ...b, gross: r.data }));
      }
      toast.show({ tone: 'success', title: `Part ${part.letter} saved` });
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  // `;code` + Tab inside the gross text expands the matching ACTIVE template (client-side, 04-UI-UX §2); unknown code → hint, text unchanged.
  const onTextKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target;
    if (e.key !== 'Tab' || e.shiftKey || e.nativeEvent.isComposing || !(el instanceof HTMLTextAreaElement)) return;
    const caret = el.selectionStart ?? el.value.length;
    const m = CODE_AT_END.exec(el.value.slice(0, caret));
    if (!m) return;
    const tpl = templates.find((t) => t.is_active && t.short_code === m[1]);
    if (!tpl) return setHint(`No template ;${m[1]}`);
    e.preventDefault();
    setHint(undefined);
    setText((el.value.slice(0, caret - m[0].length) + tpl.body + el.value.slice(caret)).slice(0, MAX_GROSS));
  };

  const upload = async (files: readonly File[]) => {
    for (const f of files) {
      const fd = new FormData();
      fd.set('file', f);
      fd.set('part_id', part.id);
      const r = await uploadGrossImageAction(caseId, fd, newKey());
      if (r.ok) toast.show({ tone: 'success', title: `Image ${f.name} uploaded` });
      else if (r.code === 'auth.mfa_required') return onMfa();
      else toast.show({ tone: 'danger', title: failText(r, caseStatus) });
    }
    router.refresh();
  };

  const title = `Part ${part.letter}${part.site_text ? ` — ${part.site_text}` : ''}`;
  return (
    <div role="group" aria-label={title}>
      <Card title={title}>
        <Form onSubmit={save} data-testid={`part-form-${part.id}`}>
          <TextField label="Site (required)" name={`site_${part.id}`} maxLength={200} isRequired value={site} onChange={setSite} />
          <TextField label="Description" name={`description_${part.id}`} maxLength={1000} value={description} onChange={setDescription} />
          <div onKeyDown={onTextKey}>
            <TextArea label="Gross description" name={`gross_text_${part.id}`} rows={8} maxLength={MAX_GROSS} showCount value={text} onChange={(v) => { setText(v); setHint(undefined); }} />
          </div>
          {hint ? <p className="lims-description" role="status">{hint}</p> : null}
          <IntegerField label="Pieces" name={`pieces_${part.id}`} min={0} max={999} {...(pieces !== undefined ? { value: pieces } : {})} onChange={setPieces} />
          <DecimalField label="Length" name={`length_${part.id}`} decimals={1} min="0.1" max="9999.9" suffix="mm" {...(length !== undefined ? { value: length } : {})} onChange={setLength} />
          <DecimalField label="Width" name={`width_${part.id}`} decimals={1} min="0.1" max="9999.9" suffix="mm" {...(width !== undefined ? { value: width } : {})} onChange={setWidth} {...(dimError ? { error: dimError } : {})} />
          <DecimalField label="Depth" name={`depth_${part.id}`} decimals={1} min="0.1" max="9999.9" suffix="mm" {...(depth !== undefined ? { value: depth } : {})} onChange={setDepth} />
          <DecimalField label="Weight (g)" name={`weight_${part.id}`} decimals={2} min="0.01" max="99999.99" {...(weight !== undefined ? { value: weight } : {})} onChange={setWeight} />
          <Switch label="Gross complete" name={`complete_${part.id}`} isSelected={complete} onChange={setComplete} />
          <FileUpload label="Gross images" name={`images_${part.id}`} accept={['image/png', 'image/jpeg']} maxBytes={15 * 1024 * 1024} multiple maxFiles={10} onSelect={(f) => void upload(f)} />
          {g ? <p className="lims-description">Grossed by {g.grossed_by_display_name}, <When value={g.updated_at} time /></p> : null}
          <Button type="submit" isLoading={pending}>Save part</Button>
        </Form>
      </Card>
    </div>
  );
}
