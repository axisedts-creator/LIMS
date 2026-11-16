T0D-MSERIES-6 writer: asset copied (cp .orchestra/notes/auth-lab-hero.webp -> packages/ui/assets/brand/lab-hero.webp; 52418 bytes, sha256 da79c2154ec250618107a02c1faa5602d86af7839f3227afc042b118a9f5149a, equal to the brief; notes copy left in place).
Files: packages/ui/src/components/EntryHero/EntryHero.tsx (photoSrc?: img.lims-auth-photo + div.lims-auth-photo-overlay first, only when non-empty), apps/web/src/core/shell/brand.ts (HERO_PHOTO = url(heroPhoto), static import), apps/web/src/app/(auth)/layout.tsx (photoSrc={HERO_PHOTO}), apps/web/src/core/shell/shell.css (two rules, the EntryHero stylesheet).
[CONV] overlay = linear-gradient(160deg, accent-hover 82% -> neutral-900 72%, color-mix with transparent); worst case over a white pixel: white 5.2 / lime 4.9 and white 7.2 / lime 5.8 (>= 4.5).
[CONV] object-position 50% 45%; mobile keeps the M5 stacked panel, photo is lazy (loads only near the viewport), never display:none.
Tests: packages/ui entry-hero-photo + R07 lint 52 passed, 1 skipped. apps/web m6 config 411/413: the 2 failures are rs-c2.static (actions.ts/messages.ts hashes, new route auth/waking/page.tsx) from T0D-WAKE-1, not touched here.
tsc: no error in the changed files (pre-existing msw onUnhandledRequest errors in unrelated tests).
Open: e2e/m6-photo.e2e.ts (1440/390 screenshots) NOT run - needs a running app (LIMS_E2E_WEB_URL). Larger photo later: replace the file, update width/height in EntryHero.tsx and the size/sha256 pin in entry-hero-photo.test.tsx.
Lead concern (LD-287) still open for the founder: Metro Labs staff and logo on the shared sign-in page.
