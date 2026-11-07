import { createElement, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FieldBase } from '../_shared/TextInputBase';
import { msg } from '../_shared/messages';

/* ---------- sanitiser (REQ-SEC-088): allowlist p, br, strong, em, u, ul, ol, li, a[href], h3, h4, table (C6 04-UI-UX:319-320) ---------- */

type Tag = 'p' | 'br' | 'strong' | 'em' | 'u' | 'ul' | 'ol' | 'li' | 'a' | 'h3' | 'h4' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td';
type SNode = string | { tag: Tag; href?: string; children: SNode[] };

const ALIAS: Record<string, Tag> = { p: 'p', div: 'p', br: 'br', strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'u', ul: 'ul', ol: 'ol', li: 'li', a: 'a', h3: 'h3', h4: 'h4', table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td' };
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

const textLength = (nodes: SNode[]): number => nodes.reduce((n, x) => n + (typeof x === 'string' ? x.length : textLength(x.children)), 0);

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

export type RichTextTool = 'bold' | 'italic' | 'underline' | 'bullet_list' | 'ordered_list' | 'table' | 'h3' | 'h4';

const TABLE = '<table><tbody><tr><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td></tr></tbody></table>';
/** [CONV] tool names. */
const TOOLS: Record<RichTextTool, { label: string; cmd: string; arg?: string }> = {
  bold: { label: 'Bold', cmd: 'bold' },
  italic: { label: 'Italic', cmd: 'italic' },
  underline: { label: 'Underline', cmd: 'underline' },
  bullet_list: { label: 'Bulleted list', cmd: 'insertUnorderedList' },
  ordered_list: { label: 'Numbered list', cmd: 'insertOrderedList' },
  table: { label: 'Table', cmd: 'insertHTML', arg: TABLE },
  h3: { label: 'Heading 3', cmd: 'formatBlock', arg: '<h3>' },
  h4: { label: 'Heading 4', cmd: 'formatBlock', arg: '<h4>' },
};

const exec = (cmd: string, arg?: string) => {
  // ponytail: execCommand is deprecated but universally supported; swap for a model-based editor if it is ever removed.
  if (typeof document.execCommand === 'function') document.execCommand(cmd, false, arg);
};

export interface RichTextEditorProps extends FieldBase {
  /** Stored HTML (allowlisted subset). Hostile input is sanitised before display. */
  value?: string;
  onChange?: (html: string) => void;
  /** Max text-content characters (not serialised HTML length). */
  maxLength: number;
  /** Toolbar shows only these tools. */
  allowed: readonly RichTextTool[];
}

export function RichTextEditor({ label, name, description, error, isRequired, isDisabled, isReadOnly, value = '', onChange, maxLength, allowed, ...rest }: RichTextEditorProps) {
  const id = useId();
  const surface = useRef<HTMLDivElement>(null);
  const emitted = useRef(value);
  const [seed, setSeed] = useState({ html: value, n: 0 });
  const [current, setCurrent] = useState(() => sanitizeHtml(value));
  const [tool, setTool] = useState(0);
  const toolRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const editable = !isDisabled && !isReadOnly;
  const tools = allowed.filter((t) => Object.hasOwn(TOOLS, t));
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
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? tools.length - 1 : (tool + d + tools.length) % tools.length;
    if (!d && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setTool(to);
    toolRefs.current[to]?.focus();
  };

  const ownError = error ?? (textLength(parse(current)) > maxLength ? msg.maxLength(label, maxLength) : undefined);
  const describedBy = [description ? `${id}-d` : '', ownError ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className="lims-field lims-rte" {...rest}>
      <span id={`${id}-l`} className="lims-label">
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </span>
      <div role="toolbar" aria-label={`${label}: formatting`} aria-controls={`${id}-s`} className="lims-rte-toolbar" onKeyDown={onToolbarKey}>
        {tools.map((k, i) => (
          <button
            key={k}
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
              exec(TOOLS[k].cmd, TOOLS[k].arg);
              emit();
            }}
          >
            {TOOLS[k].label}
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
