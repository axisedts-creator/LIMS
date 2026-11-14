# T0D-DEP-01 tests (tester)
- File: `infra/tests/static/test_t0d_dep01_images.py` (stdlib only; needs `python` and `git` on PATH; no docker, no PyYAML).
- Run: `.orchestra\notes\T0D-DEP-01-verify.cmd` (= `python -B -m unittest discover -s infra/tests/static -p "test_t0d_dep01_images.py" -v` from repo root).
- Real-file tests (9 fail now, files missing): 3 Dockerfiles, .dockerignore, .env.example, .gitignore negation + `git check-ignore`, render.yaml, T0D-DEP-01-answers.md (>=10 resolvable `path:line` cites + required tokens).
- Validator self-tests + planted failures (tag-only FROM, ARG default, root/non-numeric USER, docker.sock, COPY .env/.pem/.git/spec, no --frozen-lockfile, wrong pnpm, dev deps in final, `NAME=value`, literal secret in render.yaml, ...): 66 pass now.
- Writer contracts (section header `# ===== api =====`, comment per name, render.yaml block style, ...) are in the test module docstring.
- Current result: Ran 75, failures=9, all because the files do not exist yet.
