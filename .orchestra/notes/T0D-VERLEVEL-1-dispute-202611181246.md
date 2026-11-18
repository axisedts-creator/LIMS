# T0D-VERLEVEL-1 dispute (writer, 2026-11-18)
Test: verlevel1.settings.test.tsx "the section does not override the 30 px / 13 px compact values ... (static scan of the new file)" — line 358.
Defect: `new URL('../components/settings/VerificationPolicyTab.tsx', import.meta.url)` inside a jsdom test file is rewritten by Vite's asset-URL transform to
`http://localhost:3000/src/features/lab/components/settings/VerificationPolicyTab.tsx` (probe printed exactly that), so `existsSync` is always false. No source change can make it pass.
The file exists, and the same three regexes, run by hand on it, match nothing (outline none, height/minHeight/fontSize literals, px sizes).
Fix (tester): build the path without the URL pattern, e.g. `fileURLToPath(import.meta.url)` + `path.join(dirname, '../components/settings/VerificationPolicyTab.tsx')`,
or `resolve(process.cwd(), 'src/features/lab/components/settings/VerificationPolicyTab.tsx')` (vitest root = apps/web).
Everything else: 66 of 67 pass.
