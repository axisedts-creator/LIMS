'use client';
// 04-UI-UX §4.2.7 Preview: read-only plain rendering of what the draft will print: Gross, Microscopy, Diagnosis, Comment, Synoptic, Ancillary, Slides, Images, Codes.
// Everything is text (REQ-SEC-088). LD-140 (2026-11-13, binding): kit Card and token class names only.
import { Card } from '@lims/ui/components/Card';
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

export const Block = ({ title, text }: { title: string; text: string }) => (
  <section>
    <h3 className="lims-card-title">{title}</h3>
    {text ? <p className="lims-report-text">{text}</p> : <p className="lims-description">Nothing entered.</p>}
  </section>
);

export function ReportPreview({ data }: { data: PreviewData }) {
  return (
    <Card title="Preview" data-testid="report-preview">
      <Block title="Gross" text={data.gross} />
      <Block title="Microscopy" text={data.microscopy} />
      <Block title="Diagnosis" text={data.impression} />
      <Block title="Comment" text={data.comment} />
      <section>
        <h3 className="lims-card-title">Synoptic</h3>
        {data.synoptic.length === 0 ? <p className="lims-description">None.</p> : null}
        {data.synoptic.map((s, i) => {
          const def = data.defs[s.template_id];
          const lines = def ? visibleFields(def, s.values).flatMap((f) => (s.values[f.key] === undefined || s.values[f.key] === '' ? [] : [{ key: f.key, text: `${f.label}: ${valueText(f, s.values[f.key] as SynopticValue)}` }])) : [];
          return (
            <div key={`${s.template_id}-${i}`}>
              <p><strong>{s.title}</strong></p>
              <ul>{lines.map((l) => <li key={l.key}>{l.text}</li>)}</ul>
            </div>
          );
        })}
      </section>
      <section>
        <h3 className="lims-card-title">Ancillary</h3>
        {data.ancillary.length === 0 ? <p className="lims-description">None.</p> : null}
        <ul>{data.ancillary.map((a) => <li key={a.label}><strong>{a.label}</strong>: <span className="lims-report-text">{a.text}</span></li>)}</ul>
      </section>
      <section>
        <h3 className="lims-card-title">Slides</h3>
        {data.slides.length === 0 ? <p className="lims-description">None.</p> : null}
        <ul>{data.slides.map((s) => <li key={s.id}>{s.label}{s.stain_display ? ` — ${s.stain_display}` : ''}</li>)}</ul>
      </section>
      <section>
        <h3 className="lims-card-title">Images</h3>
        {data.images.length === 0 ? <p className="lims-description">None.</p> : null}
        <ol>{data.images.map((i, n) => <li key={i.id}>{i.caption || `Image ${n + 1}`}</li>)}</ol>
      </section>
      <section>
        <h3 className="lims-card-title">Codes</h3>
        {data.codes.length === 0 ? <p className="lims-description">None.</p> : null}
        <ul>{data.codes.map((c) => <li key={c.code}>{c.code}</li>)}</ul>
      </section>
    </Card>
  );
}
