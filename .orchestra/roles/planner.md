ROLE: PLANNER. Do not write code.
Read spec/chunks/{CHUNK}/06-IMPLEMENTATION-PLAN.md (and only the parts of 01-PRD.md needed to resolve AC ids).
Write `.orchestra/tasks/{CHUNK}.json`: a JSON array in plan order. Each item:
{"id":"<plan task id>","title":"...","depends":["<ids>"],"files":["paths from the plan"],"done_when":"...","tests":"...","acs":["AC ids"],"verify":"<shell command that proves it, e.g. pnpm -s verify, or empty>"}
Skip tasks that are blocked/deferred in the plan (B4 etc.); list them in `.orchestra/notes/{CHUNK}-skipped.md`. Reply with the task count only.
