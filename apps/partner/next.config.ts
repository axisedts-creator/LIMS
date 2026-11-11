// Partner portal (C13 02-TRD §3.6). Plain object so node can import it; no remote image host, no X-Powered-By.
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@lims/ui'],
  images: { unoptimized: true, remotePatterns: [] },
};

export default config;
