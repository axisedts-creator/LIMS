'use client';
// T0D-CONTENT-1 light Markdown editor (done_when 2, LD-313 d): a plain textarea, a toolbar for bold, italic, heading, list and link, and a live
// preview (MarkdownPreview) rendered by the SAME safe renderer as the API and the patient app (./safeMarkdown, a copy of the API file). No raw HTML:
// the shared validator's verdict is shown at once as an alert, and anything it refuses is escaped to plain text in the preview.
import { useId, useRef } from 'react';
import { Button } from '@lims/ui/components/Button';
import { t } from '@/core/i18n/messages';
import { MarkdownPreview } from '@/app/(staff)/engagement/content/MarkdownPreview';
import { bodyError } from './content-model';

type Tool = 'bold' | 'italic' | 'heading' | 'list' | 'link';
const TOOLS: readonly Tool[] = ['bold', 'italic', 'heading', 'list', 'link'];

/** The text after one toolbar action on [start, end), and the new selection. */
function applyTool(v: string, start: number, end: number, tool: Tool): { text: string; from: number; to: number } {
  const sel = v.slice(start, end);
  const wrap = (mark: string) => ({ text: v.slice(0, start) + mark + sel + mark + v.slice(end), from: start + mark.length, to: end + mark.length });
  if (tool === 'bold') return wrap('**');
  if (tool === 'italic') return wrap('*');
  if (tool === 'link') {
    const label = sel || 'text';
    const text = `${v.slice(0, start)}[${label}](https://)${v.slice(end)}`;
    const at = start + label.length + 3 + 'https://'.length;
    return { text, from: at, to: at };
  }
  const lineStart = v.lastIndexOf('\n', start - 1) + 1;
  const prefix = tool === 'heading' ? '# ' : '- ';
  return { text: v.slice(0, lineStart) + prefix + v.slice(lineStart), from: start + prefix.length, to: end + prefix.length };
}

export function MarkdownEditor({ value, onChange, isReadOnly }: { value: string; onChange: (v: string) => void; isReadOnly?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const problem = bodyError(value);

  const press = (tool: Tool) => {
    const ta = ref.current;
    if (!ta || isReadOnly) return;
    const r = applyTool(value, ta.selectionStart ?? value.length, ta.selectionEnd ?? value.length, tool);
    onChange(r.text);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.from, r.to); });
  };

  return (
    <div className="lims-field lims-md-editor">
      <label className="lims-label" htmlFor={id}>{t('engagement.content.field.body')}</label>
      <div role="toolbar" aria-label={t('engagement.content.form.toolbar')} aria-controls={id} className="lims-inline lims-md-toolbar">
        {TOOLS.map((tool) => (
          // T0D-UIX-4 (LD-442): toolbar actions are kit ghost Buttons
          <Button key={tool} variant="ghost" size="sm" isDisabled={!!isReadOnly} onPress={() => press(tool)}>
            {t(`engagement.content.tool.${tool}`)}
          </Button>
        ))}
      </div>
      <textarea
        ref={ref}
        id={id}
        name="body"
        className="lims-input"
        rows={8}
        value={value}
        readOnly={isReadOnly}
        aria-invalid={problem ? true : undefined}
        {...(problem ? { 'aria-describedby': `${id}-e` } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
      {problem ? <p id={`${id}-e`} role="alert" className="lims-error">{problem}</p> : null}
      <p className="lims-label">{t('engagement.content.form.preview')}</p>
      <MarkdownPreview source={value} />
    </div>
  );
}
