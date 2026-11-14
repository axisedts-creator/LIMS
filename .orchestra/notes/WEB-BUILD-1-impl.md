# WEB-BUILD-1 impl (writer) - PARTIAL, blocked by dispute
- config.actions.ts: getLabSettingsAction, listDeltaRulesAction now `export async function` (same bodies/names) [LD-194].
- lab/components/shared.tsx: useSerial/useRef removed; new `useSerial.ts` ('use client'); CollectDispatch.tsx + ReceiveScreen.tsx import it from './useSerial'. NO_ACCESS stays plain in shared.tsx.
- 'use client' added first line: packages/ui DiffTable.tsx and PageShell.tsx (extra, flagged by tester guard).
- Tests: 15/16 pass; 1 fails = disputed test (see WEB-BUILD-1-dispute.md).
- Real `pnpm --filter @lims/web build`: NOT run yet (needs approval in this session); no apps/web/.next exists in this lane, so verify never built web before (observation, not proven why).
