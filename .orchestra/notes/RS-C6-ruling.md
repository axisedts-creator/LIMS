TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Disputed: apps/web/src/features/reporting/__tests__/rs-c6.screens.test.tsx:121 `isRelease` tests `/^release\b/i` against the button's full `textContent`.
- Spec requires the shortcut: spec/chunks/C6-reporting-delivery/04-UI-UX.md:23 "Report detail | `Alt+R` | release latest version" (and :22 for worklist bulk release). The kit renders it as `<kbd aria-hidden="true">` after `<span class="lims-btn-label">` (packages/ui/src/components/Button/Button.tsx:41-46), so textContent = "ReleaseAlt+R" and `\b` after "Release" never matches.
- HEAD~2 already had `<Button variant="primary" shortcut="Alt+R">Release</Button>` (ReportDetailView.tsx:153); brief says behaviour unchanged (LD-140), so the writer must not drop the shortcut.
- No spec line asks the button's raw textContent to equal "Release"; the keyboard AC (task brief "tests") is about reaching and activating Release by Tab/Enter.
- Change in test, line 121 only: match the accessible content, not decorative kbd text, e.g.
  `const label = (el) => (el.querySelector('.lims-btn-label')?.textContent ?? el.textContent ?? '').trim();`
  `const isRelease = () => document.activeElement instanceof HTMLButtonElement && /^release\b/i.test(label(document.activeElement));`
  Keep `\b` (so "Release 3" bulk / "Released" are still distinguished as today). Rest of the test (lines 122-130) unchanged.
- Implementation: no change required for this test.
