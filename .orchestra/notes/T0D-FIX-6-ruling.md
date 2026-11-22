

## LEAD ITEM (LD-450, 2026-11-22 15:00 NPT)
The fixture core/__tests__/fixtures/ctx-clock-baseline.json is tester-owned: only the TESTER sets it to {} and changes nothing else. Writer and debugger never edit it or any __tests__ file (Enforce reverts it, which is what blocked this task at 14:51). Reviewer edits nothing.
