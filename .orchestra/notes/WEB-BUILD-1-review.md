APPROVE
# WEB-BUILD-1 review (reviewer), diff 9801939f..HEAD

Scope verdict: the diff is correct for LD-194 SCOPE (1)-(3) plus the mechanical PageShell fix under (4). No defects found in it.
**The task is NOT done.** done_when "`pnpm --filter @lims/web build` exits 0" is unmet. The build type-check fails (279 errors in 165 files), and the task is blocked on CR `.orchestra/cr/WEB-BUILD-1.md`, which correctly stops under LD-194 RULES (b). The impl note still owes the last 15 lines of a passing build (RULES d) once the CR is ruled.

Checked:
- config.actions.ts: getLabSettingsAction and listDeltaRulesAction are now `export async function` declarations with the same names, bodies and endpoints (`/v1/lab/settings`, `/v1/lab/delta-check-rules`). 'use server' is kept. LD-194 is cited.
- shared.tsx: the useRef import and useSerial were moved verbatim into the new `useSerial.ts`, which has 'use client' and cites LD-194. shared.tsx has no 'use client' and no hook, so labels/page.tsx still gets the plain NO_ACCESS string. The only useSerial importers (CollectDispatch, ReceiveScreen) were updated, and both are client files.
- DiffTable.tsx and PageShell.tsx now start with 'use client'. PageShell props are all ReactNode or string, so a server layout can still pass them. No behaviour, copy or styling changed.
- Forbidden paths: there are no edits to spec/, turbo.json, root package.json, the lockfile, the Dockerfile or tsconfig. All edits are in owned paths or paths LD-194 authorises.
- Not applicable to a pure UI boundary fix: RLS, permissions, idempotency, error codes. No PHI, no secrets, synthetic data only.
- Tests: build-boundaries.test.ts passes 16/16 (ran it). The planted fixtures cover (a) and (b). The tester's deviation (accepting `export const x = async`) is documented and matches Next semantics.
- Existing suites: lab-t26 36/36 and lab-t29 39/39 pass. lab-t11 has 73/74 passing. Its one failure is in `labels/LabelPage.tsx` (dangerouslySetInnerHTML/innerHTML regex), a file this diff does not touch, so it is pre-existing and not caused by WEB-BUILD-1. ui and admin suites were not run by the reviewer.
