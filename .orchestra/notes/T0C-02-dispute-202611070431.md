# T0C-02 dispute (writer)
Test: `contracts/__tests__/ports.test.ts:149` — `createRequire(...).resolve("typescript/lib/tsc.js")`.
Why wrong: repo pins `typescript` 7.0.2 (root package.json; same version added to contracts devDependencies). TS 7's package.json `exports` map exposes only `.`, `./package.json`, `./unstable/*` — `./lib/tsc.js` exists on disk but is not exported, so `resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED and the test reports "typescript not resolvable" even though it is installed. Spec pins no TS version, so downgrading would invent one.
Evidence: 62/63 tests pass. Same tsc check run by hand (copy ports + stub generated/error-codes.ts + identical tsconfig, `node contracts/node_modules/typescript/lib/tsc.js -p ...`) → exit 0, empty output.
Proposed fix (tester): resolve `typescript/package.json`, then `join(dirname(pkg), "lib/tsc.js")` (or use `bin.tsc` from package.json). Assertion unchanged.
State: `contracts/ports/*.ts` (14 files, extracted verbatim from IC §4) + `contracts/package.json` devDep `typescript: 7.0.2` left uncommitted pending ruling.
