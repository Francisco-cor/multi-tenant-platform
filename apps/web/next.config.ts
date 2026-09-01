import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone enables Docker minimal image. On Windows local without symlink privileges
  // it fails (EPERM). Enable only when STANDALONE=1 (Docker builder) or on non-Windows.
  ...(process.env.STANDALONE === '1' || process.platform !== 'win32'
    ? { output: 'standalone' as const }
    : {}),
};

export default nextConfig;
