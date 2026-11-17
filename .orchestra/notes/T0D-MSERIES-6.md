# T0D-MSERIES-6: lab photo behind the entry hero

- Asset: packages/ui/assets/brand/lab-hero.webp, copied from .orchestra/notes/auth-lab-hero.webp (LD-290). 768 x 512 WebP, 52418 bytes, sha256 da79c2154ec250618107a02c1faa5602d86af7839f3227afc042b118a9f5149a (checked after the copy).
- Overlay contrast, worst case over a pure white photo pixel (WCAG ratio, token hex from tokens.json):
  - stop 1 accent-hover at 82%: white tagline 5.2:1, lime kicker 4.9:1
  - stop 2 neutral-900 at 72%: white tagline 7.2:1, lime kicker 5.8:1
- Mobile (390): the panel stays stacked under the form as in M5; the photo is loading="lazy", so it downloads only when scrolled near.
- Screenshots at 1440 and 390: NOT taken; e2e/m6-photo.e2e.ts needs a running app (LIMS_E2E_WEB_URL).
- When a larger photo arrives: replace lab-hero.webp under the same name (no code change), then update width/height in packages/ui/src/components/EntryHero/EntryHero.tsx and the byte size/sha256/dimension pins in packages/ui/src/components/__tests__/entry-hero-photo.test.tsx, and this note.
