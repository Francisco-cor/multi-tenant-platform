import type { ReactNode } from 'react';
import { NavLink } from '@/components/nav-link';
import { RoleBadge } from '@/components/badges';
import { getPageContext } from '@/lib/context';
import { hasPermission, type Permission } from '@/lib/permissions';

const NAV: Array<{ href: string; label: string; permission?: Permission }> = [
  { href: '/', label: 'Panel' },
  { href: '/branches', label: 'Sucursales', permission: 'branches:read' },
  { href: '/orders', label: 'Pedidos', permission: 'orders:read' },
  { href: '/inventory', label: 'Inventario', permission: 'inventory:read' },
  { href: '/files', label: 'Archivos', permission: 'files:read' },
  { href: '/members', label: 'Miembros', permission: 'members:read' },
];

export default async function AppLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  const { context, me, tenant } = await getPageContext();
  const principal = { permissions: context.permissions };
  const links = NAV.filter((item) => !item.permission || hasPermission(principal, item.permission));
  const organization = context.organization;

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="container">
          <div className="site-header-inner">
            <NavLink href="/">
              <span className="brand">
                <span className="brand-mark" aria-hidden="true">
                  OH
                </span>
                <span>
                  <span className="brand-sub">Operations Hub</span>
                  {organization.name}
                </span>
              </span>
            </NavLink>
            <span className="header-spacer" />
            <div className="header-actions">
              {me.organizations.length > 1 ? (
                <form
                  className="tenant-switcher"
                  action="/api/auth/switch-organization"
                  method="post"
                >
                  <label className="small" htmlFor="organization-switch">
                    Organización
                  </label>
                  <select id="organization-switch" name="slug" defaultValue={organization.slug}>
                    {me.organizations.map((candidate) => (
                      <option key={candidate.id} value={candidate.slug}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="button button-secondary">
                    Cambiar
                  </button>
                </form>
              ) : null}
              <div className="small">
                <span className="muted">Sesión: </span>
                {context.user.displayName}
                <RoleBadge role={context.membership.role} />
              </div>
              <form action="/api/auth/logout" method="post">
                <button type="submit" className="button button-secondary">
                  Cerrar sesión
                </button>
              </form>
            </div>
          </div>
          <nav className="nav" aria-label="Navegación principal">
            {links.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main id="main" className="container" tabIndex={-1}>
        {children}
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>
            <span className="mono">{tenant.host}</span> · {organization.name} · Los permisos se
            verifican en la API en cada solicitud.
          </p>
        </div>
      </footer>
    </div>
  );
}
