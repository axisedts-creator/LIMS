# T0D-FAVICON-1 impl (writer)
- New: apps/web/src/app/{favicon.ico (16/32/48, 7.8 KB), icon.png (192, 5.4 KB), apple-icon.png (180, 5.9 KB), manifest.ts}, apps/web/public/icon-512.png (512, 16 KB). Edited: app/layout.tsx (metadata only), src/middleware.ts (matcher).
- Generation: Python Pillow 12.2.0 from packages/ui/assets/brand/ml-logo.png only; LANCZOS resize, 64-colour palette PNG (no dither, optimize=True); apple-icon flattened on white (iOS paints transparency black); favicon.ico via Pillow ICO writer sizes 16/32/48. Script not committed (one-off).
- [CONV] manifest theme_color #005A52 (accent.default), background_color #FFFFFF (neutral.0) from tokens.json; 192 src /icon.png (app convention), 512 src /icon-512.png in public/ (test forbids extra top-level entries in app/).
- [CONV] title {default 'Metro Labs', template '%s - Metro Labs'} + description; no metadata.icons/manifest, conventions inject the links.
- Middleware matcher extended to skip icon.png, apple-icon.png, icon-512.png, manifest.webmanifest: otherwise logged-out tabs (login screen) got a 307 to /auth/login instead of the icon, and every icon fetch cost a session resolve. Not in the brief's file list; 8 files total.
- Done_when 4: login (LOGO_ON_LIGHT) and shell (LOGO_ON_DARK) already show the mark; no change. No routes, brand folder, (auth)/(platform)/admin/platform files touched.
- Checks: favicon1 config 15/15; audit-small-1 11/11; wake1.middleware + web-auth-redirect pass. tsc: only pre-existing errors (portal, web-auth-redirect.test.ts). Not verified in a real browser.
