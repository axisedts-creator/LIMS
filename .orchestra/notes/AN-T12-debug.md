# AN-T12 debugger
Cause: no impl bug. Only failure = first handler test "group_by none (default)" hits default 5000ms vitest timeout. It pays one-off cold cost (dynamic import of handlers/index.js in helpers.t12 + ajv schema compile): 3.1s alone, 7.6s when the 3 files run in parallel (verify cmd). Other tests in file: ~15ms each.
Logic passes: 52/52 alone, 90/91 together.
Fix: none in impl (nothing slow in tat code). Needs test-side or config timeout (testTimeout ~20000, or beforeAll warm-up). I may not edit tests; vitest.config edit is authorised only for setup-env (LD-53). Lead/tester decide.
