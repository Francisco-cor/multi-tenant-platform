import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/feedback';
import { SubmitButton } from '@/components/submit-button';
import { getAuthMe } from '@/lib/api';
import { allowDevLogin } from '@/lib/config';
import { getTenantRequest } from '@/lib/context';
import { firstParam, type SearchParams } from '@/lib/page-params';
import { readSessionToken } from '@/lib/session';
import { tenantLabel } from '@/lib/tenant';

export const metadata: Metadata = {
  title: 'Iniciar sesión',
};

const ERRORS: Record<string, string> = {
  session_expired: 'Tu sesión caducó. Vuelve a iniciar sesión.',
  not_member: 'Tu usuario no pertenece a esta organización.',
  dev_login_disabled: 'El acceso de desarrollo está desactivado en este entorno.',
  csrf: 'La solicitud no procedía del formulario de la aplicación.',
  tenant_required: 'La dirección no incluye una organización válida.',
  user_required: 'Indica un usuario para continuar.',
  login_failed: 'No se pudo iniciar sesión. Revisa el usuario e inténtalo de nuevo.',
  oidc_unavailable: 'El proveedor de identidad no está configurado en este entorno.',
  oidc_failed: 'El proveedor de identidad no completó el inicio de sesión.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactNode> {
  const { tenant } = await getTenantRequest();
  const token = await readSessionToken();
  if (token) {
    const me = await getAuthMe(token).catch(() => null);
    if (me?.organizations.some((organization) => organization.slug === tenant.slug)) {
      redirect('/');
    }
  }

  const error = await firstParam(searchParams, 'error');
  const label = tenantLabel(tenant.slug);

  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <div className="auth-card">
        <p className="eyebrow">Operations Hub</p>
        <h1>Entrar en {label}</h1>
        <p className="muted">
          Organización <span className="mono">{tenant.slug}</span>. La sesión se guarda en una
          cookie HttpOnly en este dominio; el navegador nunca recibe el token de la API.
        </p>

        {error ? (
          <Alert tone="error" title="No se pudo iniciar sesión">
            {ERRORS[error] ?? 'Se produjo un error inesperado.'}
          </Alert>
        ) : null}

        <a className="button" href="/api/auth/oidc/start">
          Continuar con SSO (OIDC)
        </a>

        {allowDevLogin ? (
          <>
            <div className="divider">o acceso de desarrollo</div>
            <form action="/api/auth/login" method="post" className="stack-sm">
              <div className="field">
                <label htmlFor="dev-user">Usuario de desarrollo</label>
                <input
                  id="dev-user"
                  name="userId"
                  required
                  autoComplete="off"
                  list="dev-users"
                  aria-describedby="dev-user-hint"
                  placeholder="user-alice"
                />
                <datalist id="dev-users">
                  <option value="user-alice">Alice Owner (acme owner, contoso manager)</option>
                  <option value="user-acme-only">Acme Operator (acme operator)</option>
                  <option value="user-contoso-only">Contoso Owner (contoso owner)</option>
                </datalist>
                <span id="dev-user-hint" className="field-hint">
                  Solo disponible con <span className="mono">ALLOW_DEV_LOGIN=1</span> fuera de
                  producción.
                </span>
              </div>
              <SubmitButton pendingLabel="Entrando…">Entrar</SubmitButton>
            </form>
          </>
        ) : (
          <p className="muted small section">
            El acceso de desarrollo está desactivado. Usa el proveedor de identidad configurado.
          </p>
        )}

        <p className="muted small section">
          ¿No es tu organización? Comprueba el subdominio: cada organización usa su propio host.
        </p>
      </div>
    </main>
  );
}
