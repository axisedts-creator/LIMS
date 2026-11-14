# T0D-DEP-01 impl (writer)
- Files: services/api/Dockerfile, services/worker/Dockerfile, apps/web/Dockerfile, .dockerignore, .gitignore (+`!.env.example`), render.yaml, notes/T0D-DEP-01-answers.md, cr/T0D-DEP-01.md. No app source, no next.config.mjs change.
- `.env.example` now written at repo root (verbatim copy of `.orchestra/notes/T0D-DEP-01-env.example.txt`); tracked, not git-ignored.
- Review fix (17:30): `LIMS_ORIGIN_PORTAL` added to api + worker groups, `LIMS_ORIGIN_STAFF_WEB` to api group (both in .env.example and the notes copy).
- Tests (review-fix pass, 2026-11-14): `python -B -m unittest discover -s infra/tests/static -p test_t0d_dep01_images.py` Ran 75, OK.
- [CONV] pnpm via `npm install -g pnpm@12.18.0` (= packageManager); every image: `COPY . .` (dockerignore-filtered) + whole-workspace `pnpm install --frozen-lockfile --prod`; runtime mirrors repo layout under /app (REPO_ROOT needs contracts/, packages/fakes); USER 10001:10001.
- [CONV] web: build stage full install + `pnpm --filter @lims/web build`; runtime `node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3000`; `.next/cache` symlinked to /tmp for the read-only rootfs.
- Open: CR T0D-DEP-01 APPROVED (lead 17:05): C0-0A moves `pg` to dependencies + regenerates lockfile; no Dockerfile change here. Until it lands, the API image fails at boot with LIMS_CORE_DATABASE_URL set.
- Not verified (no docker daemon here): no image was built or run; pnpm 12 `--prod` workspace behaviour, Next 16 bin path and Next writes outside .next/cache under --read-only are unproven. Whether Render passes NODE_BASE_IMAGE as a build arg: UNKNOWN.
