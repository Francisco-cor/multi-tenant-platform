import type { NextConfig } from 'next';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Document CSP is nonce-based and therefore generated per request in
 * middleware.ts (Next needs the nonce at render time). The static assets
 * below never render HTML, so they get a locked-down fallback policy here.
 */
const staticAssetCsp = [
  "default-src 'none'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Keep the origin (not just the path) cross-origin. Chrome suppresses the
  // Origin header on form POSTs under `no-referrer`, which breaks the BFF CSRF
  // check, so use the strict-but-origin-preserving default instead.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  // Tenant documents are per-host and per-user: keep every intermediary honest
  // even if a route handler or Next's own defaults rewrite Cache-Control.
  { key: 'Vary', value: 'Host, Cookie' },
  { key: 'Cache-Control', value: 'private, no-store' },
  ...(isProduction
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains; preload',
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Dev-only guard for tenant subdomains (e.g. acme.app.localhost).
  allowedDevOrigins: [`*.${process.env.TENANT_BASE_DOMAIN ?? 'app.localhost'}`],
  // Standalone enables Docker minimal image. On Windows local without symlink privileges
  // it fails (EPERM). Enable only when STANDALONE=1 (Docker builder) or on non-Windows.
  ...(process.env.STANDALONE === '1' || process.platform !== 'win32'
    ? { output: 'standalone' as const }
    : {}),
  experimental: {
    serverActions: {
      // File uploads are forwarded by a server action; keep it above the default 1 MB.
      bodySizeLimit: '12mb',
    },
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: staticAssetCsp },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          { key: 'Vary', value: 'Accept-Encoding' },
        ],
      },
      {
        source: '/favicon.svg',
        headers: [
          { key: 'Content-Security-Policy', value: staticAssetCsp },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
          { key: 'Vary', value: 'Accept-Encoding' },
        ],
      },
      {
        source: '/robots.txt',
        headers: [
          { key: 'Content-Security-Policy', value: staticAssetCsp },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
          { key: 'Vary', value: 'Accept-Encoding' },
        ],
      },
    ];
  },
};

export default nextConfig;
