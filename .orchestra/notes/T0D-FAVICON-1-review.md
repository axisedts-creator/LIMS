APPROVE

T0D-FAVICON-1 review (diff d451ddc4c..HEAD)
- done_when 1: favicon.ico 16/32/48 (7.8 KB), icon.png 192 (5.4 KB), apple-icon.png 180 (5.9 KB), generated with Pillow from ml-logo.png; how they were made is in T0D-FAVICON-1-impl.md.
- done_when 2: manifest.ts has name/short_name Metro Labs, start_url /, standalone, #005A52 / #FFFFFF (both in tokens.json), icons 192 + 512 (public/icon-512.png, 16 KB).
- done_when 3: title {default 'Metro Labs', template '%s - Metro Labs'} + description; no explicit icons/manifest in metadata.
- done_when 4/6: login (LOGO_ON_LIGHT) and shell (LOGO_ON_DARK) unchanged; brand folder, routes, (auth)/(platform)/admin/platform untouched.
- middleware.ts matcher change is outside the brief's file list but needed: logged-out icon/manifest fetches were getting a 307. It only exempts static asset names, so no auth gap; rs-c2.static still passes.
- No PHI, secrets, RLS, permissions or error codes in scope.
- Non-blocking: the matcher lookahead is not end-anchored, so `/icon.pngX` would also skip middleware; no such route exists. The file count is 9 counting the tester's vitest config (repo convention).
- Checks run: favicon1 15/15; audit-small-1 11/11; web-auth-redirect-1 80/80; web-auth-redirect-2 90/90; wake1.middleware + rs-c2.static + c2.client-context 30/30.
- Not verified: rendering in a real browser or a PWA install.
