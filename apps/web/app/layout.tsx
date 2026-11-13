import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { tenantBaseDomain } from '@/lib/config';
import { tenantLabel } from '@/lib/tenant';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const slug = requestHeaders.get('x-tenant-slug');
  const label = slug ? tenantLabel(slug) : 'Operations Hub';
  const base = process.env.WEB_PUBLIC_URL ?? `http://${tenantBaseDomain}:3000`;
  return {
    metadataBase: new URL(base),
    title: {
      default: `${label} · Operations Hub`,
      template: `%s · ${label} · Operations Hub`,
    },
    description:
      'Plataforma multi-tenant de operaciones: pedidos, inventario, archivos y equipo por organización.',
    applicationName: 'Operations Hub',
    robots: { index: false, follow: false },
    icons: { icon: '/favicon.svg' },
    openGraph: {
      type: 'website',
      siteName: 'Operations Hub',
      title: `${label} · Operations Hub`,
      description: 'Operaciones por organización con aislamiento multi-tenant.',
    },
    formatDetection: { telephone: false, email: false, address: false },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        <a className="skip-link" href="#main">
          Saltar al contenido principal
        </a>
        {children}
      </body>
    </html>
  );
}
