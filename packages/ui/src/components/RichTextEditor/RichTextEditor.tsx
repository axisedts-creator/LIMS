import { createElement, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FieldBase } from '../_shared/TextInputBase';
import { msg } from '../_shared/messages';

/* ---------- sanitiser (REQ-SEC-088): allowlist p, br, strong, em, u, ul, ol, li, a[href] ---------- */

type Tag = 'p' | 'br' | 'strong' | 'em' | 'u' | 'ul' | 'ol' | 'li' | 'a';
type SNode = string | { tag: Tag; href?: string; children: SNode[] };

const ALIAS: Record<string, Tag> = { p: 'p', div: 'p', br: 'br', strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'u', ul: 'ul', ol: 'ol', li: 'li', a: 'a' };
/** Removed with their content. Everything else that is not allowlisted is unwrapped to its text. */
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'img', 'picture', 'video', 'audio', 'canvas', 'head', 'title', 'link', 'meta', 'base', 'textarea', 'select', 'input']);
const SAFE_HREF = /^(https?:\/\/|\/(?![/\\])|#)/i;

function walk(node: Node): SNode[] {
  if (node.nodeType === 3) return [node.textContent ?? ''];
  if (node.nodeType !== 1) return [];
  const el = node as Element;
  const name = el.localName.toLowerCase();
  if (DROP.has(name)) return [];
  const children = Array.from(el.childNodes).flatMap(walk);
  const tag = ALIAS[name];
  if (!tag) return children;
  if (tag === 'br') return [{ tag, children: [] }];
  if (tag === 'a') {
    const href = (el.getAttribute('href') ?? '').trim();
    return SAFE_HREF.test(href) && !/[\s\u0000-\u001f]/.test(href) ? [{ tag, href, children }] : children;
  }
  return [{ tag, children }];
}

/** Parse untrusted HTML into the allowlisted tree. DOMParser documents are inert (no script, no resource loads). */
function parse(html: string): SNode[] {
  if (!html || typeof DOMParser === 'undefined') return html ? [html] : [];
  return Array.from(new DOMParser().parseFromString(html, 'text/html').body.childNodes).flatMap(walk);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const serialise = (nodes: SNode[]): string =>
  nodes
    .map((n) =>
      typeof n === 'string'
        ? esc(n)
        : n.tag === 'br'
          ? '<br>'
          : n.tag === 'a'
            ? `<a href="${esc(n.href ?? '')}">${serialise(n.children)}</a>`
            : `<${n.tag}>${serialise(n.children)}</${n.tag}>`,
    )
    .join('');

/** Untrusted HTML -> allowlisted HTML string (what the editor emits and what servers should re-check). */
export function sanitizeHtml(html: string): string {
  return serialise(parse(html));
}

const toReact = (nodes: SNode[]): ReactNode[] =>
  nodes.map((n, i) =>
    typeof n === 'string'
      ? n
      : createElement(n.tag, n.tag === 'a' ? { key: i, href: n.href, rel: 'noopener noreferrer' } : { key: i }, n.tag === 'br' ? undefined : toReact(n.children)),
  );

export interface SafeHtmlProps {
  html: string;
  'data-testid'?: string;
}

/** Renders stored rich text as React elements (no raw-HTML injection; C6 04-UI-UX:137). */
export function SafeHtml({ html, ...rest }: SafeHtmlProps) {
  const nodes = useMemo(() => toReact(parse(html)), [html]);
  return (
    <div className="lims-richtext" {...rest}>
      {nodes}
    </div>
  );
}

/* ---------- editor ---------- */

const TOOLS = [
  { label: 'Bold', cmd: 'bold' },
  { label: 'Italic', cmd: 'italic' },
  { label: 'Underline', cmd: 'underline' },
  { label: 'Bulleted list', cmd: 'insertUnorderedList' },
  { label: 'Numbered list', cmd: 'insertOrderedList' },
] as const;

const exec = (cmd: string, arg?: string) => {
  // ponytail: execCommand is deprecated but universally supported; swap for a model-based editor if it is ever removed.
  if (typeof document.execCommand === 'function') document.execCommand(cmd, false, arg);
};

export interface RichTextEditorProps extends FieldBase {
  /** Stored HTML (allowlisted subset). Hostile input is sanitised before display. */
  value: string;
  onChange?: (html: string) => void;
  /** REQUIRED: max length of the stored HTML. */
  maxLength: number;
}

export function RichTextEditor({ label, name, description, error, isRequired, isDisabled, isReadOnly, value, onChange, maxLength, ...rest }: RichTextEditorProps) {
  const id = useId();
  const surface = useRef<HTMLDivElement>(null);
  const emitted = useRef(value);
  const [seed, setSeed] = useState({ html: value, n: 0 });
  const [current, setCurrent] = useState(() => sanitizeHtml(value));
  const [tool, setTool] = useState(0);
  const toolRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const editable = !isDisabled && !isReadOnly;
  // Same element identity across our own re-renders, so React never touches DOM the user is editing.
  const seedNodes = useMemo(() => toReact(parse(seed.html)), [seed]);

  // External value change (not our own echo) -> re-seed the surface.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setSeed((s) => ({ html: value, n: s.n + 1 }));
    setCurrent(sanitizeHtml(value));
  }, [value]);

  const emit = () => {
    const el = surface.current;
    if (!el) return;
    const html = sanitizeHtml(el.innerHTML);
    setCurrent(html);
    if (html === emitted.current) return;
    emitted.current = html;
    onChange?.(html);
  };

  const onToolbarKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? TOOLS.length - 1 : (tool + d + TOOLS.length) % TOOLS.length;
    if (!d && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setTool(to);
    toolRefs.current[to]?.focus();
  };

  const ownError = error ?? (current.length > maxLength ? msg.maxLength(label, maxLength) : undefined);
  const describedBy = [description ? `${id}-d` : '', ownError ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className="lims-field lims-rte" {...rest}>
      <span id={`${id}-l`} className="lims-label">
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </span>
      <div role="toolbar" aria-label={`${label}: formatting`} aria-controls={`${id}-s`} className="lims-rte-toolbar" onKeyDown={onToolbarKey}>
        {TOOLS.map((t, i) => (
          <button
            key={t.cmd}
            ref={(el) => {
              toolRefs.current[i] = el;
            }}
            type="button"
            className="lims-btn lims-btn-ghost lims-btn-sm"
            tabIndex={i === tool ? 0 : -1}
            disabled={!editable}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              surface.current?.focus();
              exec(t.cmd);
              emit();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        key={seed.n}
        ref={surface}
        id={`${id}-s`}
        role="textbox"
        aria-multiline="true"
        aria-labelledby={`${id}-l`}
        aria-describedby={describedBy}
        aria-invalid={ownError ? true : undefined}
        aria-required={isRequired ? true : undefined}
        aria-readonly={isReadOnly ? true : undefined}
        aria-disabled={isDisabled ? true : undefined}
        tabIndex={isDisabled ? -1 : 0}
        className="lims-input lims-rte-surface lims-richtext"
        contentEditable={editable}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onPaste={(e) => {
          // pasted markup never enters the DOM: plain text only
          e.preventDefault();
          if (editable) exec('insertText', e.clipboardData.getData('text/plain'));
          emit();
        }}
        onDrop={(e) => e.preventDefault()}
      >
        {seedNodes}
      </div>
      <input type="hidden" name={name} value={current} />
      {description ? (
        <span id={`${id}-d`} className="lims-description">
          {description}
        </span>
      ) : null}
      {ownError ? (
        <span id={`${id}-e`} className="lims-error">
          {ownError}
        </span>
      ) : null}
    </div>
  );
}
