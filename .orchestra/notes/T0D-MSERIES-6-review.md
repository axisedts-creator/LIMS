APPROVE

Reviewed `git diff 3d65ad8a2..HEAD` (notes only: debugger round, load-induced timeout of m6.photo "no remote image URL") plus the task implementation it rests on (cb4b64a98, tests eb65843a2).
- Asset: packages/ui/assets/brand/lab-hero.webp 52418 bytes, sha256 da79c2154ec250618107a02c1faa5602d86af7839f3227afc042b118a9f5149a (re-checked; matches brief).
- brand.ts HERO_PHOTO = url(static import), same pattern as LOGO_ON_LIGHT/MARK; no remote URL, no data URI; CSP untouched.
- EntryHero optional photoSrc: img alt="" aria-hidden, lazy, async, width 768 height 512, first in DOM (behind rings/scene, no z-index); omitted = M5 output. (auth)/layout.tsx passes HERO_PHOTO, so every entry screen gets it.
- shell.css: two rules, tokens only (accent-hover, neutral-900 via color-mix), object-fit cover, object-position 50% 45%, no fixed size. Spot-checked contrast over a white pixel: white ~6.0:1, lime ~5.0:1 (>= 4.5).
- Presentation only: no forms/actions/routes/contracts/auth/logs touched; no DB, RLS, permissions or error codes in scope; no PHI, no secrets; paths owned per brief.
- Tests run by reviewer 2026-11-17 04:48: web m6 config 16 files 425/425 passed; packages/ui entry-hero-photo + raw-style lint (verify filter) 52 passed, 1 skipped.
- Note (not a task defect): the unfiltered "real tree" raw-style case fails on 24 violations, all in pre-existing test files of other tasks (web-style*, m2.source, rs-c6/c7/c15 static tests); excluded by this task's verify filter.
- Open (as impl notes say): e2e/m6-photo.e2e.ts 1440/390 screenshots need a running app; not run.
