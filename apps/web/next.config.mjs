import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// LD-198: packages/ui/dist/tokens.css is a git-ignored build output; generate it when missing (apps/portal precedent).
const ui = fileURLToPath(new URL('../../packages/ui/', import.meta.url));
if (!existsSync(`${ui}dist/tokens.css`)) execFileSync(process.execPath, ['scripts/build-tokens.ts'], { cwd: ui, stdio: 'inherit' });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@lims/ui'],
  // LD-195 (WEB-BUILD-2): build type-check skips tests; tsconfig.json + the typecheck script still cover them.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  images: { unoptimized: true, remotePatterns: [] }, // no remote image origin (08 A18.1)
  // T0D-BUNDLE-1 (LD-310 / LD-312): react-aria ships 34 locales of screen-reader strings per component; keep en-US only.
  turbopack: { rules: { 'intlStrings.mjs': { loaders: [fileURLToPath(new URL('./scripts/aria-locales-loader.cjs', import.meta.url))] } } },
};

export default nextConfig;
