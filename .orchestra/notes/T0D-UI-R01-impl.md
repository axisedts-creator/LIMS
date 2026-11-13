# T0D-UI-R01 impl
Files: packages/ui/tokens/tokens.json (s2.1-2.3 values + accent.hover/highlight/brand, tone.critical.solid), tokens/contrast-pairs.json (+8 s2.6 rows), src/theme/accent.ts (DEFAULT_ACCENT #0E4B3B, dark fg #13241D, LD-140 cited); regenerated src/tokens.ts, ui-flutter/lib/src/tokens.g.dart (dist/tokens.css untracked build output).
[CONV] elevation written `0.06`/`0.10` (spec `.06`; same CSS value). critical.solid pair declared as neutral.0 on tone.critical.solid.
[CONV] contrast pair neutral.300 vs neutral.50 kind `ui` (non-text 3:1).
Tests: T0D-UI-R01 files 84/84 pass. Full packages/ui: 1125/1128; 2 date/table tests time out only under full-suite load (pass 181/181 in isolation).
Re-run after ruling (static-guards revised): task tests + static-guards 93/93 pass, tsc clean, regenerated outputs no diff.
Open: Plus Jakarta font files = CR-UI-R-001.
