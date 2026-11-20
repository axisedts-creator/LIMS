TESTS_WRONG — testmgmt1.screens.test.tsx:171 requires a label matching /^text format/i while line 173 requires `within(dlg).getByLabelText(/^text/i)` to be unique in the same dialog; both cannot hold.
Change in the test: at line 171 replace `/^text format/i` with `/^(text )?format/i` (keep lines 173 and 187 as they are). Optionally also assert the POST body carries `text_format` when a non-plain format is chosen.
Reasons:
1. The spec never names this label: grep of spec/ for "text format|text_format|is_default_template" finds only spec/chunks/C1-infrastructure-ops/02-TRD.md:803 (Prometheus text format, unrelated). The label "Text format" is the tester's wording, not a spec name.
2. Task brief (.orchestra/inbox/T0D-TESTMGMT-1-arbiter.md:20, done_when item 6) lists the "note" screen with no field labels; LD-318 (same file :31) says parity fields come from the ElabAssist evidence and does not fix label text.
3. Existing green test apps/web/src/features/catalog/__tests__/web-t33.components.test.tsx:362,376,389,402,417 queries this same dialog with getByLabelText(/^text/i); a "Text format" label would break it, and LD-318 (1) says parity is additive, nothing existing broken.
4. Implementation (CommentCodesScreen.tsx:106, label "Format", name text_format, plain|markdown) delivers the field the test intends; only the label regex is over-specific.
5. Not disputed: the range-manager age-unit wording note in the dispute needs no ruling.
