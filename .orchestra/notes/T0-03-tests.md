# T0-03 tests (revised per LD-04 / LD-05)
- File: tests/monorepo/T0-03.pins.test.mjs (node:test, no deps). Run: `node --test tests/monorepo/T0-03.pins.test.mjs` (verify: .orchestra/notes/T0-03-verify.cmd).
- LD-04: table now read from `db/meta/decisions/T0-03-dependencies.md` (whole file; one markdown table, 6 CV §15.1 cols, a row per §2.2/[PIN-C0] item, exact version, allowed licence, ISO last-release date, alternatives). spec/ untouched.
- LD-05: new test requires rows for the 14 T0D-12 CR pins (react-aria-components 1.22.1, react/react-dom 19.3.1, @fontsource/noto-sans* 5.3.0, RTL 16.3.3, user-event 14.6.8, @types/react(-dom) 19.3.0, axe-core 4.14.0, jsdom 31.0.0, typescript 7.0.2, vitest 5.1.0). Fonts may be rows named "Noto Sans…" or the @fontsource name. Lockfile test covers pnpm-lock vs package.json once packages/ui deps land.
- Changed: banned-list tests now allow `bikram-sambat` ONLY as devDependency of packages/test-fixtures (CV §15.3 line 1195: test oracle); new test forbids any other use / app-code import. Previously failed on that legit oracle.
- Expected now: 11 of 25 fail (decisions file absent -> 7 table tests, lockfile specifiers vitest/ajv/yaml, pubspec.lock absent, root pubspec `sdk: ^3.6.0`, pubspec exactness); 14 pass.
- Not testable: CI gate 13 wiring, docker digests (vacuous), network egress. Local node is v25.8.0 vs .nvmrc 26.x (installed-tree checks).
