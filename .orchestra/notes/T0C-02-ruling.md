TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- AC-0C-1.2 (spec/chunks/C0-foundation-contracts/01-PRD.md:166) requires only that `tsc --noEmit` passes over `contracts/ports/`. It says nothing about which module path the compiler is loaded from. Plan row T0C-02 (06-IMPLEMENTATION-PLAN.md:83) says the same: "`tsc --noEmit`; signature snapshot vs IC text".
- The TypeScript version is [PIN-C0]: C0 picks it when it implements (spec/program/02-CONVENTIONS.md:13, :30). The pinned 7.0.2 is allowed. I checked its package.json: `exports` has only `.`, `./package.json` and `./unstable/*`, so `require.resolve("typescript/lib/tsc.js")` throws ERR_PACKAGE_PATH_NOT_EXPORTED. The file `lib/tsc.js` is still on disk.
- Line 149 therefore fails because of how the test finds the compiler, not because of anything the spec requires.

Change to the test (contracts/__tests__/ports.test.ts:149), and only this:
- Replace `createRequire(join(contractsDir, "package.json")).resolve("typescript/lib/tsc.js")` with
  `join(dirname(createRequire(join(contractsDir, "package.json")).resolve("typescript/package.json")), "lib", "tsc.js")`,
  then assert `existsSync(tscJs)` and keep the same error message.
- Leave every other assertion as it is: the temp copy, the stubbed error-codes, the tsconfig, `stdout+stderr === ""` and `status === 0`.
- The writer's devDependency `typescript: 7.0.2` in contracts/package.json is allowed under [PIN-C0]. It must match the root pin, and the version must be recorded in C0 02-TRD (02-CONVENTIONS.md:13).
