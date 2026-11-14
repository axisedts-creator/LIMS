# T0D-DEP-01 impl (writer)
- Earlier rounds: 3 Dockerfiles, .dockerignore, .env.example, .gitignore (+`!.env.example`), render.yaml, notes/T0D-DEP-01-answers.md. Unchanged this round.
- LD-176 round (LD-175 pts 1-3): services/api/package.json `"pg": "8.23.1"` moved devDependencies -> dependencies (@types/pg stays dev); pnpm-lock.yaml regenerated with `pnpm install --lockfile-only` (pnpm 12.18.0): only the services/api importer entry moved. render.yaml += `region: singapore` on lims-api; no healthCheckPath (/health/live is on LIMS_CORE_METRICS_PORT 9464).
- Answers note keeps UNKNOWN for what a hosted Supabase project supplies (lead fills in).
- [CONV] images: `npm install -g pnpm@12.18.0`, `COPY . .` + `pnpm install --frozen-lockfile --prod`, USER 10001:10001; web runs `next start -p 3000`, `.next/cache` -> /tmp.
- Tests 2026-11-14: `python -B -m unittest discover -s infra/tests/static -p test_t0d_dep01_images.py` Ran 83, OK.
- Not verified (no docker daemon): no image built or run; read-only-rootfs behaviour of Next unproven; whether Render passes NODE_BASE_IMAGE as a build arg: UNKNOWN.
