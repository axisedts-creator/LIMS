APPROVE
Re-review of `git diff e876c089..HEAD` (T0D-12b) after review round 1 (items 1-9).

All 9 items are fixed:
1. pnpm-lock.yaml: no longer in the committed diff. The impl note is corrected. The working tree still has an uncommitted lockfile change (M) from pnpm runs. Do NOT commit it; it belongs to C0-0A / CR-C0-0D-001.
2. SecretRevealOnce matches C7 02-TRD:1094: {label, secret, expiresAt?, requireAcknowledgement=true, onAcknowledged}, checkbox text "I have copied this code", and the secret leaves the DOM after Done.
3. CodeBlock matches C7 02-TRD:1093: {label, text, renderControlChars, maxHeight, wrap, allowCopy=false}. No `caption` prop.
4. ImageThumbnailGrid matches C6 04-UI-UX:323-324. Caption, remove and reorder use buttons, so they work from the keyboard. Only same-origin `ready` images get an `<img>`.
5. PdfFileCard matches C6 04-UI-UX:325: {filename, sizeBytes, pageCount?, state, stateLabel, tone, onDownload?}.
6. OtpInput matches C6 04-UI-UX:322. `onComplete` fires when all digits are filled and when Enter is pressed on a complete code.
7. RichTextEditor matches C6 04-UI-UX:319-320: `allowed` filters the toolbar, `maxLength` counts text characters, `value` is optional. h3/h4/table are in the one allowlist, which SafeHtml shares.
8. PeriodPicker has the required `presets` prop; the IDs match C8 02-TRD:1093-1094 verbatim.
9. DurationText has `style` 'short'|'long'. 'short' follows C8 04-UI-UX:51; 'long' is marked [CONV].

Checks run: `pnpm --filter @lims/ui exec vitest run src/components/__tests__/phase1` passes 4 files / 180 tests. `tsc --noEmit` is clean.
Only owned paths are touched: packages/ui/src/components/** plus the role notes. No secrets, no PHI and no logging.
Not applicable to this UI-only task: RLS, permissions, idempotency, rate tier, error codes.
Known open items, not defects (stated in the impl note): there is no B.S. date input for a custom range, ImageThumbnailGrid does not enforce `max`, and the editor uses execCommand.
