/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@lims/ui'],
  // LD-195 (WEB-BUILD-2): build type-check skips tests; tsconfig.json + the typecheck script still cover them.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  images: { unoptimized: true, remotePatterns: [] }, // no remote image origin (08 A18.1)
};

export default nextConfig;
