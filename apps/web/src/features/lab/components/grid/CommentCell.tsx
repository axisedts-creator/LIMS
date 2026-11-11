'use client';
// C5.T-18 — result-grid comment cell with short codes (04-UI-UX §3.6; PRD AC-10.1, AC-10.3). ":CODE" + Space/Tab expands to the library text; Ctrl+Space opens a picker.
// The server re-resolves every code on save (AC-10.2) — this only helps typing. Library text is rendered as plain characters (S-14): value of a textarea, never HTML.
import { useId, useLayoutEffect, useRef, useState } from 'react';

export interface CommentCode { code: string; text: string; version: number }
export interface CommentCellProps {
  label?: string;
  defaultValue?: string;
  defaultCodes?: readonly string[];
  /** C3 GET /v1/catalog/comment-codes?code_prefix=<prefix> through the BFF (listCommentCodes #57); wired by the grid screen (T-20). */
  lookupCode(prefix: string): Promise<readonly CommentCode[]>;
  onChange?(next: { text: string; codes: string[] }): void;
}

const TOKEN = /(^|\s):([A-Z0-9_]{1,16})$/;

export function CommentCell({ label = 'Comment', defaultValue = '', defaultCodes = [], lookupCode, onChange }: CommentCellProps) {
  const [text, setText] = useState(defaultValue);
  const [hint, setHint] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ items: readonly CommentCode[]; active: number } | null>(null);
  const textRef = useRef(defaultValue);
  const codesRef = useRef<string[]>([...new Set(defaultCodes)]);
  const hintRef = useRef<string | null>(null);
  const caret = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const seq = useRef(0);   // drops stale picker responses
  const id = useId();

  useLayoutEffect(() => { if (caret.current !== null && area.current && !picker) { area.current.setSelectionRange(caret.current, caret.current); caret.current = null; } });
  useLayoutEffect(() => { if (picker && document.activeElement !== search.current) search.current?.focus(); }, [picker !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit(next: string, codes: string[], at?: number) {
    textRef.current = next; codesRef.current = codes; setText(next);
    if (at !== undefined) caret.current = at;
    if (hintRef.current && !next.includes(`:${hintRef.current}`)) { hintRef.current = null; setHint(null); }
    onChange?.({ text: next, codes: [...codes] });
  }
  const withCode = (code: string) => (codesRef.current.includes(code) ? codesRef.current : [...codesRef.current, code]);
  const spaced = (before: string, ins: string) => (before && !/\s$/.test(before) ? ' ' : '') + ins + ' ';

  async function expand(start: number, token: string, key: string) {
    const code = token.slice(1);
    let found: CommentCode | undefined, known = true;
    try { found = (await lookupCode(code)).find((c) => c.code === code); } catch { known = false; }   // failure: claim nothing about the code
    const cur = textRef.current;
    if (cur.slice(start, start + token.length) !== token) return;   // edited while the lookup ran
    if (found) {
      commit(cur.slice(0, start) + found.text + ' ' + cur.slice(start + token.length), withCode(code), start + found.text.length + 1);
    } else {
      if (known) { hintRef.current = code; setHint(code); }
      if (key === ' ') commit(cur.slice(0, start + token.length) + ' ' + cur.slice(start + token.length), codesRef.current, start + token.length + 1);
    }
  }

  async function openPicker(prefix: string) {
    const n = ++seq.current;
    let items: readonly CommentCode[] = [];
    try { items = await lookupCode(prefix); } catch { /* empty list */ }
    if (n === seq.current) setPicker({ items, active: 0 });
  }
  function closePicker() { seq.current++; caret.current = null; setPicker(null); area.current?.focus(); }
  function pick(c: CommentCode) {
    const at = caret.current ?? textRef.current.length;
    const cur = textRef.current, ins = spaced(cur.slice(0, at), c.text);
    seq.current++; setPicker(null);
    commit(cur.slice(0, at) + ins + cur.slice(at), withCode(c.code), at + ins.length);
    area.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.ctrlKey && e.key === ' ') { e.preventDefault(); caret.current = e.currentTarget.selectionStart; void openPicker(''); return; }
    if ((e.key !== ' ' && e.key !== 'Tab') || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const pos = e.currentTarget.selectionStart;
    if (pos !== e.currentTarget.selectionEnd) return;
    const m = TOKEN.exec(textRef.current.slice(0, pos));
    if (!m) return;
    e.preventDefault();   // the trigger key belongs to the token
    const token = `:${m[2]}`;
    void expand(pos - token.length, token, e.key);
  }

  const listId = `${id}-codes`, hintId = `${id}-hint`;
  return (
    <div>
      <textarea ref={area} aria-label={label} aria-describedby={hint ? hintId : undefined} value={text} rows={2}
        onChange={(e) => commit(e.target.value, codesRef.current)} onKeyDown={onKeyDown} />
      {hint && <p id={hintId} role="status">Unknown code {hint}</p>}
      {picker && (
        <div>
          <input ref={search} type="search" aria-label="Search codes" aria-controls={listId} defaultValue=""
            onChange={(e) => void openPicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setPicker({ ...picker, active: Math.min(picker.active + 1, picker.items.length - 1) }); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setPicker({ ...picker, active: Math.max(picker.active - 1, 0) }); }
              else if (e.key === 'Enter') { e.preventDefault(); const c = picker.items[picker.active]; if (c) pick(c); }
            }} />
          <ul id={listId} role="listbox" aria-label="Comment codes">
            {picker.items.map((c, i) => (
              <li key={c.code} role="option" aria-selected={i === picker.active} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
                <strong>{c.code}</strong> {c.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
