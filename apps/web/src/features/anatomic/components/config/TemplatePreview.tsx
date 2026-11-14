'use client';
// 04-UI-UX §4.7 live preview of a synoptic template (the same kit fields the report editor composes): plain-text section headings, one control per VISIBLE field labelled by its
// label with "(required)" in the label text, unit and help text, Show-if fields only while their trigger matches, a polite live region "{n} more fields shown" (04-UI-UX §6).
// Everything is rendered as TEXT by React: markup in a label or heading never becomes an element (REQ-SEC-088, 07-SECURITY "malicious template"). Nothing typed here is kept or sent.
// LD-140 (2026-11-13, binding): kit components only.
import { useState } from 'react';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import type { DefField, Definition } from '../../server/config.types';
import { visibleKeys } from './builder-model';

type Answers = Record<string, boolean | string | readonly string[] | undefined>;

export function TemplatePreview({ definition }: { definition: Definition }) {
  const [answers, setAnswers] = useState<Answers>({});
  const all = definition.sections.flatMap((s) => s.fields);
  const visible = visibleKeys(all, answers);
  const revealed = all.filter((f) => f.show_if && visible.has(f.key)).length;
  const set = (key: string, v: Answers[string]) => setAnswers((a) => ({ ...a, [key]: v }));

  const control = (f: DefField, name: string) => {
    const label = f.required ? `${f.label} (required)` : f.label;
    const common = { label, name, ...(f.help_text ? { description: f.help_text } : {}) };
    switch (f.type) {
      case 'long_text':
        return <TextArea {...common} maxLength={f.max_length ?? 4000} />;
      case 'boolean':
        return <Checkbox label={label} name={name} {...(f.help_text ? { description: f.help_text } : {})} isSelected={answers[f.key] === true} onChange={(v) => set(f.key, v)} />;
      case 'single_select':
        return <Select {...common} options={(f.options ?? []).map((o) => ({ value: o.code, label: o.display }))} {...(typeof answers[f.key] === 'string' ? { value: answers[f.key] as string } : {})} onChange={(v) => set(f.key, v)} />;
      case 'multi_select': {
        const chosen = (answers[f.key] as readonly string[] | undefined) ?? [];
        return (
          <fieldset className="lims-field">
            <legend className="lims-label">{label}</legend>
            {(f.options ?? []).map((o) => (
              <Checkbox key={o.code} label={o.display} isSelected={chosen.includes(o.code)} onChange={(on) => set(f.key, on ? [...chosen, o.code] : chosen.filter((c) => c !== o.code))} />
            ))}
          </fieldset>
        );
      }
      case 'date':
        return <DatePicker {...common} {...(typeof answers[f.key] === 'string' ? { value: answers[f.key] as IsoDate } : {})} onChange={(v) => set(f.key, v)} />;
      case 'integer':
      case 'decimal':
        return <TextField {...common} maxLength={20} inputMode="numeric" {...(f.unit_text ? { suffix: f.unit_text } : {})} />;
      default:
        return <TextField {...common} maxLength={f.max_length ?? 500} />;
    }
  };

  return (
    <section data-preview aria-labelledby="synoptic-preview-title">
      <h2 id="synoptic-preview-title" className="lims-section-title">Preview</h2>
      <p className="lims-description">{definition.title}</p>
      {definition.sections.map((s, si) => (
        <div key={si}>
          <h3>{s.heading}</h3>
          {s.fields.map((f, fi) => (visible.has(f.key) ? <div key={`${si}-${fi}-${f.key}`}>{control(f, `preview_${si}_${fi}`)}</div> : null))}
        </div>
      ))}
      <p aria-live="polite" className="lims-description">{revealed > 0 ? `${revealed} more fields shown` : ''}</p>
    </section>
  );
}
