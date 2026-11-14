'use client';
// Top-bar global search (10-DESIGN-SYSTEM §3, T0D-UI-R04, LD-140). Enter submits (no per-keystroke call). Ctrl/Cmd+K
// focuses it from anywhere; a scanner wedge typing [A-Z0-9] while nothing editable has focus lands here (first char kept).
// The lookup itself is the server action in search-action.ts (this file never touches the API or the token).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n/messages';
import { globalSearch, type SearchResult } from './search-action';

const EDITABLE = 'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"])';
const DIALOG = '[role="dialog"], [role="alertdialog"], dialog';

export function GlobalSearch({ canPatients, canSpecimens }: { canPatients: boolean; canSpecimens: boolean }) {
  const router = useRouter();
  const box = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const last = useRef<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const resultsId = useId();

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const input = box.current;
      if (!input) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || !/^[A-Z0-9]$/.test(e.key)) return;
      const active = document.activeElement;
      // modal dialogs trap focus, so "focus inside a dialog" covers an open dialog
      if (active instanceof Element && active !== document.body && active.closest(`${EDITABLE}, ${DIALOG}`)) return;
      e.preventDefault();
      input.value = e.key; // a new scan replaces the old query
      last.current = null;
      input.focus();
      input.setSelectionRange(1, 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function submit() {
    const query = (box.current?.value ?? '').trim();
    // `last` = the query already submitted and not edited since (repeat Enter is a no-op; editing or a new scan clears it)
    if (!query || last.current === query) return;
    const mine = ++seq.current;
    last.current = query;
    const r = await globalSearch(query, { patients: canPatients, specimens: canSpecimens });
    if (mine !== seq.current) return; // a newer search was submitted
    if (r.kind === 'error') last.current = null; // allow a retry
    if (r.kind === 'order') {
      setResult(null);
      router.push(`/frontdesk/orders/${encodeURIComponent(r.orderId)}`); // route staff.frontdesk.order
    } else setResult(r);
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    else if (e.key === 'Escape') setResult(null);
  };

  return (
    <div className="lims-search" role="search">
      <input
        ref={box}
        type="search"
        className="lims-input lims-search-input"
        aria-label={t('core.shell.search_label')}
        placeholder={t('core.shell.search_placeholder')}
        maxLength={100}
        autoComplete="off"
        aria-controls={result ? resultsId : undefined}
        onKeyDown={onKeyDown}
        onInput={() => { last.current = null; }}
      />
      <kbd className="lims-search-hint" aria-hidden="true">{t('core.shell.search_hint')}</kbd>
      {result?.kind === 'patients' ? (
        <section id={resultsId} className="lims-popover lims-search-results" aria-label={t('core.shell.search_results')}>
          <ul>
            {result.items.map((p) => (
              <li key={p.id}>
                <Link href={`/frontdesk/patients/${encodeURIComponent(p.id)}`} onClick={() => setResult(null)}>
                  <span>{p.name}</span> <span className="lims-search-code">{p.code}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result?.kind === 'none' ? <p id={resultsId} role="status" className="lims-popover lims-search-results">{t('core.shell.search_none')}</p> : null}
      {result?.kind === 'error' ? <p id={resultsId} role="alert" className="lims-popover lims-search-results">{t('core.shell.search_failed')}</p> : null}
    </div>
  );
}
