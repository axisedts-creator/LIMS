APPROVE

# T0D-12c review (diff b09b6043..fe82838a)
- Scope: only packages/ui/src/components/BarcodeSymbol/** + new tests in components/__tests__/ + own notes (LD-107). No package.json change, no new dependency, no third-party encoder.
- LD-107 rules met: VALID=^[A-Z0-9-]{1,32}$, fixed error message without the value, no console use, value only in aria-label + showText <text>; sets B/C only, Start B/C, DP-minimal packing, checksum mod 103 (start weight 1), stop 2331112; svg viewBox in modules, role=img, crispEdges, numeric <rect> geometry, literal #000/#fff (no colour guard exists), width = modules x moduleWidthMm mm; no effects/browser APIs. 0.25 mm minimum not enforced (TRD s4.6, as LD says).
- Width table spot-checked against ISO/IEC 15417 (values 0, 33, 99-105); tests self-check 106 distinct 11-module patterns.
- Tests cover done_when/ACs: independent decoder round trip (1-char, even/odd digits, mixed, 32-char), checksum, stop, quiet zones, packing = BFS minimum, code128Modules == viewBox width, rejection (empty/lowercase/space/33/non-ASCII/null/number) without echo, console never called, node-env renderToStaticMarkup, stories + axe (stories-axe glob, AC-0D-8.6), literal-colour independence of theme (AC-0D-8.3).
- Font 'Noto Sans Mono' is bundled (assets/fonts/fonts.css) and matches tokens font.family.mono.
- RLS/permissions/idempotency/rate tier/error codes: n/a (pure UI component). No PHI/secrets.

## Checks run (reviewer)
- `npx vitest run --no-file-parallelism barcodesymbol stories-axe static-guards`: 5 files, 310/310 pass.
- `pnpm --filter @lims/ui exec tsc --noEmit`: clean.
- Full @lims/ui suite under parallel load: worker-start timeouts + 1 timing flake in batch2-data Combobox debounce (not in this diff; passes when rerun in isolation). Environmental, not a T0D-12c defect.

## Non-blocking notes
- Negative/NaN moduleWidthMm or heightMm are not validated (would emit "-Nmm"); spec silent, C5 LabelRenderer owns sizing.
- Default 50/12-module heights are writer choices; lead may pin in 04-UI-UX s2.5.
