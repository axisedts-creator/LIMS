import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// packages/ui/dist/tokens.css is a build output; build it so `next dev` works on a fresh checkout.
const ui = fileURLToPath(new URL('../../packages/ui/', import.meta.url));
if (!existsSync(`${ui}dist/tokens.css`)) execFileSync(process.execPath, ['scripts/build-tokens.ts'], { cwd: ui, stdio: 'inherit' });

// Server actions compare Origin with Host; behind the public nginx the host is the portal origin (REQ-SEC-091).
const portalHost = process.env.LIMS_ORIGIN_PORTAL ? new URL(process.env.LIMS_ORIGIN_PORTAL).host : undefined;

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@lims/ui'],
  images: { unoptimized: true, remotePatterns: [] }, // no remote image origin (08 A18.1)
  experimental: { serverActions: { allowedOrigins: portalHost ? [portalHost] : [] } },
  async headers() {
    return [{ source: '/.well-known/apple-app-site-association', headers: [{ key: 'content-type', value: 'application/json' }] }];
  },
};
