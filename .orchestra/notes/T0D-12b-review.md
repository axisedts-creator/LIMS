CHANGES
Reviewed `git diff e876c089..HEAD` (T0D-12b) against C0 04-UI-UX §2.8 and the requesting chunks' prop specs. C0 §2.8 says "props as in the requesting chunk's 04-UI-UX unless stated". The tester marked these APIs "ASSUMED" (phase1-display.test.tsx:4-14) even though the spec defines them, and the writer copied those assumptions. Each item below needs a fix in both the component and its tests/stories.

1. pnpm-lock.yaml (+1202 lines, commit 8c344fb): this path belongs to C0-0A (01-CHUNK-MAP §3, line 100). Fix: `git checkout e876c089 -- pnpm-lock.yaml` and leave the lockfile to CR-C0-0D-001 (.orchestra/cr/T0D-12.md). Also correct .orchestra/notes/T0D-12b-impl.md, which says "pnpm-lock.yaml was unchanged in this run". It was changed.

2. packages/ui/src/components/SecretRevealOnce/SecretRevealOnce.tsx:5-13,41: the spec (spec/chunks/C7-instrument-integration/02-TRD.md:1094) gives `{ label: string; secret: string; expiresAt?: IsoUtc; onAcknowledged: () => void }`, plus `requireAcknowledgement?: boolean` (default true; C0 04-UI-UX §2.8, 08 R22). Fix: rename `value`→`secret` and `onDone`→`onAcknowledged`, add `expiresAt?` (shown as text), and make the checkbox text exactly "I have copied this code" (it is now "I have copied it and stored it safely"). Update phase1-display tests and the story to match.

3. packages/ui/src/components/CodeBlock/CodeBlock.tsx:28-37: the spec (C7 02-TRD.md:1093) gives `{ label: string; text: string; renderControlChars?: boolean; maxHeight?: number; wrap?: boolean; allowCopy?: boolean /* default false */ }`. Fix: rename `value`→`text`, add `maxHeight?` (max-height on the region, which scrolls) and `wrap?` (pre-wrap vs pre), and remove the invented `caption` prop. Update tests and story.

4. packages/ui/src/components/ImageThumbnailGrid/ImageThumbnailGrid.tsx:1-13: the spec (spec/chunks/C6-reporting-delivery/04-UI-UX.md:323-324; C6 02-TRD.md:1269 "caption field, reorder, remove") gives `{ items: {id; src /* BFF URL */; caption?; state: 'scanning'|'ready'|'rejected'}[]; onCaptionChange?; onRemove?; onReorder?; captionMaxLength: number; max: number }`. The current version uses `images`, an `alt` field, states 'processing'/'quarantined' and `onSelect`, and has no caption editing, reorder or remove. Fix: implement the spec interface and behaviour, including keyboard-operable reorder, and add unit, keyboard and axe tests for caption, remove and reorder.

5. packages/ui/src/components/PdfFileCard/PdfFileCard.tsx:11-21: the spec (C6 04-UI-UX.md:325) gives `{ filename: string; sizeBytes: number; pageCount?: number; state: string; stateLabel: string; tone: Tone; onDownload?: () => void }`. Fix: rename `fileName`→`filename`. Take `stateLabel` and `tone` from the caller instead of the built-in state map, `rejectReason`, `confirmedBy` and `confirmedAt`, and replace `actions` with `onDownload` (Download button). Update tests and story.

6. packages/ui/src/components/OtpInput/OtpInput.tsx:4-9: the spec (C6 04-UI-UX.md:322) gives `{ label; length: 6; value?; onChange?; onComplete?: (v) => void; error?; isDisabled? }`. Fix: rename `onSubmit`→`onComplete`. Enter-to-submit and complete-fill should both call `onComplete` (C0 §2.8 "Enter submits"). Change tests to match.

7. packages/ui/src/components/RichTextEditor/RichTextEditor.tsx:94-100,141: the spec (C6 04-UI-UX.md:319-320) gives `value?: string`, `maxLength: number /* text content chars */`, and `allowed: readonly ('bold'|'italic'|'underline'|'bullet_list'|'ordered_list'|'table'|'h3'|'h4')[]`. Fix:
   - Add the required `allowed` prop and show only the toolbar tools it lists.
   - Count `maxLength` against the text content (`surface.textContent.length`), not the length of the serialised HTML.
   - Make `value` optional.
   - `table`, `h3` and `h4` are in the spec allowlist but not in the sanitiser (line 7/10). Either add them to `Tag`/`ALIAS`/serialise, or write a CR if you leave them out. SafeHtml (C6 :320) must use the same allowlist.
   - Add tests for `allowed` filtering and for text-length counting.

8. packages/ui/src/components/PeriodPicker/PeriodPicker.tsx:46-51: the spec (C8 02-TRD.md:1093-1094) gives `{ value: PeriodValue; presets: (...)[]; calendar }`. There is no `presets` prop now, so callers cannot limit the list (C4 reuse; C8 04-UI-UX:44). Fix: add the required `presets` prop and render only those options. Add a test.

9. packages/ui/src/components/DurationText/DurationText.tsx:15-18: the spec (C8 02-TRD.md:1094) gives `DurationText {seconds; style: 'short'|'long'}`. `style` is missing. Fix: add `style` ('short' = C8 04-UI-UX:51 format; 'long' = full words, marked [CONV]) and test both.

Checked and OK: SafeHtml/sanitizeHtml (inert DOMParser parsing, href allowlist, text nodes only); DataUriImage (strict regex, `<img>` only); PrintFrame (sandbox has no allow-scripts, no src); CodeBlock `allowCopy` defaults to false; FreshnessBadge copy matches C8 :47 verbatim; QrCode not built. Not applicable to this UI-only task: RLS, permissions, idempotency, error codes. Found no PHI in logs and no secrets.
