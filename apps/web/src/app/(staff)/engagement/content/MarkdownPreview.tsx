'use client';
// T0D-CONTENT-1 live preview (LD-313 d, REQ-SEC-088): the ONLY place the portal content screen injects HTML, and what it injects is always the
// output of the shared safe renderer (renderMarkdown: whitelisted tags, everything else escaped). It lives in the route folder because the
// engagement feature folders keep a no-raw-HTML guard (t-q4.source); nothing else here sets HTML.
import { t } from '@/core/i18n/messages';
import { renderMarkdown } from '@/features/engagement/components/content/safeMarkdown';

export function MarkdownPreview({ source }: { source: string }) {
  let rendered = '';
  try { rendered = renderMarkdown(source); } catch { rendered = ''; } // over the limit: the editor's alert says why, the preview stays empty
  return <section aria-label={t('engagement.content.form.preview')} className="lims-md-preview" dangerouslySetInnerHTML={{ __html: rendered }} />;
}
