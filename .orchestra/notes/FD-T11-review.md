APPROVE
Re-review of `git diff 252aeca3..HEAD` (FD-T11) after review fixes e8213e48 / 2de9c880.
1. Fixed: booking.service.ts:196-199 checks a USER actor's centre scope after parse, before lock() or any write, and throws `common.not_found` (same as F9). An undefined scope fails closed, which is stricter than F9 and acceptable. New booking contract case: centre A to A2 gives not_found with no writes, and scope [A, A2] passes.
2. Fixed: `.orchestra/cr/FD-T11.md` (CR-C4-FD-T11-001) is filed in template form, the gate stays fail closed, and FrontdeskPort.impl.ts:30 cites the CR.
Reviewer re-ran tests/frontdesk/FD-T11.pg.sh: 3 files, 51/51 pass. No new names, logging, secrets or unowned paths in the delta.
