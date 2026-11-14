/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@lims/ui'],
  images: { unoptimized: true, remotePatterns: [] }, // no remote image origin (08 A18.1)
};

export default nextConfig;
