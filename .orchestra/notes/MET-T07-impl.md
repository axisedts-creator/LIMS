# MET-T07 impl (writer)
Files changed: none outside this note. MET-T07 is a regression task, tests only (owned path is `__tests__/**`); T01-T06 already satisfy them. No test edited. [CONV] no src change needed.
Run 1, full C7 suite (`vitest run src/modules/instruments/__tests__`, 588 s): 53/54 files pass, 1793 pass, 4 todo (known, MET-T03), 2 FAIL in boot.test.ts, 8 worker crashes (exit 3221225794 = 0xC0000142, Windows resource exhaustion); only 54 of the expected 62 files ran. NOT a green full run.
Re-run alone: met-t07.getein_metis.regression.test.ts 11/11 pass (12 s); boot.test.ts 28/28 pass (152 s). The 2 boot failures were a 120 s test timeout under load and a "module payments: index.ts exports no manifest" error seen mid-crash; neither reproduced alone.
Open: full suite never completed green here. Rerun `.orchestra\notes\MET-T07-verify.cmd` on a quieter machine or with `--pool=forks --maxWorkers=2`. Not verified: the 8 files lost to worker crashes, web toggle, pgTAP.
