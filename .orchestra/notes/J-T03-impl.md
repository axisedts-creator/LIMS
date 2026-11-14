# J-T03 impl
- Changed: apps/web/src/features/billing/__tests__/copy-scan.mjs (C4-owned shipped scanner; tools/lint/ has only tests).
- [CONV] BANNED now whitespace-tolerant (`\s`, `[\s-]+`) and matched over whole file text, not per line; line no. = newlines before match + 1.
- Fixes the 4 failing bypass tests (wrapped, double-space, tab, nbsp, JSX wrap). Banned list unchanged (US-BL-16.1).
- Job c04-copy-scan already in pr.yml + branch-protection.json; no change needed.
- Open: message catalog (core/i18n/messages.ts, shared) not scanned; needs CR if required.
