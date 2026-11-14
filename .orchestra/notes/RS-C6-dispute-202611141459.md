# RS-C6 dispute: rs-c6.screens.test.tsx "keyboard only: Tab reaches Release ..." (line 117-131)
- Test finds the page Release button with `/^release\b/i.test(activeElement.textContent.trim())`.
- Kit `Button` (packages/ui/src/components/Button/Button.tsx:42-46) renders `<kbd aria-hidden>Alt+R</kbd>` inside the button when `shortcut` is set, so textContent is "ReleaseAlt+R". No word boundary after "Release", so the regex never matches; 60 Tabs cannot satisfy it.
- Not caused by RS-C6: HEAD has the same `<Button variant="primary" shortcut="Alt+R">Release</Button>`. Only fix on my side is dropping the shortcut hint (04-UI-UX s1.1, aria-keyshortcuts), which is not appearance-only; I will not do that.
- Ask: match the accessible name (`.lims-btn-label` text or aria-label) or `/^release/i`. The dialog Release has no shortcut and works.
- Everything else: 58/59 pass, 7 snapshots recorded (LD-170).
