APPROVE

Range a4b00083..HEAD (AN-T17 LD-83 follow-up).
- packages/ui RadioGroup.tsx: exactly the LD-83 / CR-C8-NEW change (optional per-option `isDisabled`, spread onto `<Radio>`); group-level isDisabled untouched; nothing else in packages/ui edited. Cites LD-83.
- ExportDialog.tsx: `as never` cast removed, comment cites LD-83; PDF option disabled unless pdfEnabled, Excel/CSV stay enabled.
- CR file moved to resolved; impl note updated. No PHI, no secrets, no invented names; only owned paths + the LD-83-authorised kit file.
- Checks run by reviewer: AN-T17 verify config 30/30 pass (incl. PDF-disabled + PDF-selectable); packages/ui fields + stories-axe tests 245/245 pass; apps/web `tsc --noEmit` shows no errors in analytics components/server or RadioGroup.
- Not re-checked: full packages/ui suite (writer reports 983/984, unrelated DataTable timeout); web lint.
