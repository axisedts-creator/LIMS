# T0D-12c impl (writer)
- Files: packages/ui/src/components/BarcodeSymbol/BarcodeSymbol.tsx (encoder + component, BarcodeSymbol + code128Modules exported), BarcodeSymbol.stories.tsx (CSF3; picked up by stories-axe glob, no registration file needed).
- Encoder: own ISO/IEC 15417 width table; sets B/C only; DP over (position, set) gives minimum symbol count (digit pairs packed, switch only where it pays); checksum mod 103; stop 2331112.
- [CONV] Invalid value / bad quietZoneModules (non-integer or <0) throw Error with a fixed message (never the value). Value in DOM only as aria-label and the showText <text> node.
- [CONV] Geometry: white <rect> over viewBox + one black <rect> per bar, integer module coords, literal #fff/#000 (no colour guard exists). viewBox "0 0 W H", preserveAspectRatio="none".
- [CONV] Height: H = round(heightMm/moduleWidthMm) modules when both given, else 50 modules; showText reserves 12 modules for the text inside H. width attr only when moduleWidthMm given; height attr only when heightMm given (heightMm = total svg height incl. text).
- Checks: full @lims/ui vitest 25 files / 1074 tests green; barcodesymbol verify 86/86; tsc --noEmit clean. No eslint in repo.
- Open: default sizes (50/12 modules) are writer choices, lead may pin them in 04-UI-UX s2.5; real scanner/print not verified.
