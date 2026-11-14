// Narrative rich-text sanitiser (REQ-SEC-088; 02-TRD §2 "HTML sanitiser", CR-C6-019): DOMPurify on a jsdom window, explicit allowlist,
// no regex tag stripping. jsdom runs with its defaults (no script execution, no sub-resource loading) and the markup is only parsed,
// never evaluated. The output is plain serialised HTML containing only the formatting tags below and no attributes besides table spans.
// [CONV] jsdom + dompurify are loaded synchronously at module import (createRequire), so no request pays the cold-load cost.
import { createRequire } from 'node:module';

const CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'sub', 'sup', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  KEEP_CONTENT: true,
} as const;

interface Purifier { sanitize(html: string, cfg: Record<string, unknown>): unknown }
interface Dom { window: { document: { body: { textContent: string | null } } } }
type DomCtor = new (html?: string) => Dom;

const require = createRequire(import.meta.url);
let JSDOM: DomCtor | undefined;
let purify: Purifier | undefined;
function deps() {
  JSDOM ??= (require('jsdom') as { JSDOM: DomCtor }).JSDOM;
  purify ??= (require('dompurify') as (w: unknown) => Purifier)(new JSDOM('').window);
  return { JSDOM, purify };
}
deps(); // warm at import: the ~2.3 s cold load must not land on the first N3/N9 request (C6-T17 verify: it timed out at 5 s)

/** Returns allowlisted HTML only. Idempotent: sanitiseHtml(sanitiseHtml(x)) === sanitiseHtml(x). */
export function sanitiseHtml(html: string): string {
  return String(deps().purify.sanitize(html, { ...CONFIG, RETURN_DOM: false, RETURN_DOM_FRAGMENT: false }));
}

/** True when the sanitised html shows no text (empty tags, whitespace, nbsp, br only): the AC-05.4 "empty required section" test. */
export function isBlankHtml(html: string): boolean {
  const { JSDOM: Dom } = deps();
  const doc = new Dom(sanitiseHtml(html)).window.document;   // parse only: scripts off, nothing loaded
  return (doc.body.textContent ?? '').trim().length === 0;   // trim() also drops U+00A0
}
