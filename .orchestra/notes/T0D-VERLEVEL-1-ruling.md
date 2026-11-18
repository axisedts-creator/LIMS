TESTS_WRONG — the static-scan test (verlevel1.settings.test.tsx:356-364) fails on path resolution, not on anything the spec requires.
Reasons:
1. Requirement is done_when (3) of the task brief (compact density of T0D-DENSITY-1, 30 px controls, 13 px text, visible focus) and LD-353 UI rule (2) (one control height per density, 30 compact). The test's intent (no outline:none, no literal height/fontSize/px overrides in VerificationPolicyTab.tsx) is valid and stays.
2. Line 358 builds the path with `new URL('../components/settings/VerificationPolicyTab.tsx', import.meta.url)`; under the jsdom/Vite transform this becomes an http://localhost URL, so `existsSync` is always false.
3. Arbiter reproduced it: running only this test gives "components/settings/VerificationPolicyTab.tsx must exist: expected false to be true", while apps/web/src/features/lab/components/settings/VerificationPolicyTab.tsx exists on disk.
4. Arbiter ran the same three regexes over that file: 0 matches, so the implementation already meets the requirement.
CHANGE (tester): at line 358 resolve a filesystem path instead of a URL, e.g.
  `const { fileURLToPath } = await import('node:url'); const { dirname, join } = await import('node:path');`
  `const f = join(dirname(fileURLToPath(import.meta.url)), '../components/settings/VerificationPolicyTab.tsx');`
  or `resolve(process.cwd(), 'src/features/lab/components/settings/VerificationPolicyTab.tsx')` (vitest root = apps/web).
Keep the existsSync assertion and all three regex assertions unchanged. No implementation change needed.
