import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Operations Hub',
  description: 'Multi-tenant operations platform',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
