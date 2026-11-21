# T0D-UIGUARD-1-INVENTORY tests (tester)
- Registry: deleted all INVENTORY entries (rule 2, rule 6, rule 7) from apps/web/src/core/__tests__/uiguard1.exceptions.ts (LD-441); uiguard1.guard.test.ts goes red on the real violations.
- New: apps/web/src/features/inventory/__tests__/uiguard1.inventory.test.ts (RulesView uses FilterBar; ReportBody chart in ChartCard; every inventory component file passes rule 7 and rule 5; registry has no INVENTORY line).
- Config: .../inventory/__tests__/vitest.uiguard1-inventory.config.ts (this file + core uiguard1.guard.test.ts).
- Run: .orchestra/notes/T0D-UIGUARD-1-INVENTORY-verify.cmd
- WRITER: delete the INVENTORY lines from notes/T0D-UIGUARD-1-exceptions.md (rule 2/6 section ~97-102, rule 7 section ~254-260); re-record rs-cN snapshots yourself (LD-440). Rule 7 files: BenchView, ReportBody, StockView, IssueDrawer, UnresolvedView, consoleParts.
