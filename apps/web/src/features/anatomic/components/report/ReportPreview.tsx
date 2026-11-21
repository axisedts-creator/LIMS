'use client';
// 04-UI-UX §4.2.7 Preview: read-only plain rendering of what the draft will print: Gross, Microscopy, Diagnosis, Comment, Synoptic, Ancillary, Slides, Images, Codes.
// Everything is text (REQ-SEC-088). LD-140 (2026-11-13, binding): kit Card and token class names only.
import { Card } from '@lims/ui/components/Card';
import { Stack } from '@lims/ui/components/Stack';
import type { Definition } from '../../server/config.types';
import type { DiagnosisCode, SynopticValue } from '../../server/report.types';
import type { CaseImage, Slide } from '../../server/types';
import { valueText, visibleFields, type SynInstance } from './SynopticForm';
import './report.css';

export interface PreviewData {
  gross: string; microscopy: string; impression: string; comment: string;
  synoptic: readonly SynInstance[]; defs: Readonly<Record<string, Definition>>;
  ancillary: readonly { label: string; text: string }[]; slides: readonly Pick<Slide, 'id' | 'label' | 'stain_display'>[];
  images: readonly Pick<CaseImage, 'id' | 'caption'>[]; codes: readonly DiagnosisCode[];
}

// LD-439 (a), LD-436 rule 7: each block is a Card title row (kit h2) and its lines a Stack, not raw h3 / ul / ol.
export const Block = ({ title, text }: { title: string; text: string }) => (
  <Card title={title}>
    {text ? <p className="lims-report-text">{text}</p> : <p className="lims-description">Nothing entered.</p>}
  </Card>
);

export function ReportPreview({ data }: { data: PreviewData }) {
  return (
    <Card title="Preview" data-testid="report-preview">
      <Block title="Gross" text={data.gross} />
      <Block title="Microscopy" text={data.microscopy} />
      <Block title="Diagnosis" text={data.impression} />
      <Block title="Comment" text={data.comment} />
      <Card title="Synoptic">
        {data.synoptic.length === 0 ? <p className="lims-description">None.</p> : null}
        {data.synoptic.map((s, i) => {
          const def = data.defs[s.template_id];
          const lines = def ? visibleFields(def, s.values).flatMap((f) => (s.values[f.key] === undefined || s.values[f.key] === '' ? [] : [{ key: f.key, text: `${f.label}: ${valueText(f, s.values[f.key] as SynopticValue)}` }])) : [];
          return (
            <div key={`${s.template_id}-${i}`}>
              <p><strong>{s.title}</strong></p>
              <Stack gap={1}>{lines.map((l) => <p key={l.key}>{l.text}</p>)}</Stack>
            </div>
          );
        })}
      </Card>
      <Card title="Ancillary">
        {data.ancillary.length === 0 ? <p className="lims-description">None.</p> : null}
        <Stack gap={1}>{data.ancillary.map((a) => <p key={a.label}><strong>{a.label}</strong>: <span className="lims-report-text">{a.text}</span></p>)}</Stack>
      </Card>
      <Card title="Slides">
        {data.slides.length === 0 ? <p className="lims-description">None.</p> : null}
        <Stack gap={1}>{data.slides.map((s) => <p key={s.id}>{s.label}{s.stain_display ? ` — ${s.stain_display}` : ''}</p>)}</Stack>
      </Card>
      <Card title="Images">
        {data.images.length === 0 ? <p className="lims-description">None.</p> : null}
        <Stack gap={1}>{data.images.map((i, n) => <p key={i.id}>{i.caption || `Image ${n + 1}`}</p>)}</Stack>
      </Card>
      <Card title="Codes">
        {data.codes.length === 0 ? <p className="lims-description">None.</p> : null}
        <Stack gap={1}>{data.codes.map((c) => <p key={c.code}>{c.code}</p>)}</Stack>
      </Card>
    </Card>
  );
}
