'use client';
// Shared client helpers for the SR-04 tabs: user-facing failure text (never raw server text) and the editor context.
import { createContext, useContext } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import type { ActionResult, FieldError } from '../server/actions';
import { NOT_DRAFT } from '../library';

export interface EditorCtx {
  versionId: string;
  language: 'en' | 'ne';
  readOnly: boolean;
  /** Reports a failed action to the page (no-longer-draft banner); returns the text to show next to the form. */
  failed: (r: Extract<ActionResult, { ok: false }>) => string;
  saved: () => void;
}
export const Ctx = createContext<EditorCtx | null>(null);
export const useEditor = () => useContext(Ctx)!;

export function failText(r: { status: number; code: string }): string {
  if (r.code === 'smartreport.library_invalid_transition') return NOT_DRAFT;
  if (r.code === 'common.version_conflict' || r.code === 'common.precondition_failed') return 'This was changed by someone else. Reload to see the latest version.';
  if (r.status === 404) return 'This item was not found or is no longer available.';
  if (r.status === 400 || r.code === 'smartreport.library_invalid') return 'Some values were not accepted. Check the fields and try again.';
  return 'Could not save. Try again.';
}

/** Field-level server errors keyed by JSON pointer ("/text_en" -> "text_en"). */
export const byField = (errors: FieldError[] = []) => Object.fromEntries(errors.map((e) => [e.path.replace(/^\//, ''), e.message]));

export function ErrorAlert({ text }: { text?: string | undefined }) {
  return text ? <div role="alert"><Banner tone="danger" title={text} /></div> : null;
}
