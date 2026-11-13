import type { ReactNode } from 'react';
import { RoleBadge, StatusBadge } from '@/components/badges';
import { Alert, EmptyState } from '@/components/feedback';
import { SubmitButton } from '@/components/submit-button';
import { listMembers } from '@/lib/api';
import { getPageContext } from '@/lib/context';
import { firstParam, type SearchParams } from '@/lib/page-params';
import { hasPermission } from '@/lib/permissions';
import { inviteMemberAction, removeMemberAction } from '../actions';

const ERRORS: Record<string, string> = {
  invalid_email: 'Introduce una dirección de correo válida.',
  conflict: 'Ese miembro ya existe en la organización.',
  forbidden: 'Tu rol no permite gestionar miembros.',
  not_found: 'El miembro ya no existe.',
  invalid: 'La solicitud no es válida.',
  unavailable: 'La API no está disponible en este momento.',
};

const ROLES = ['operator', 'manager', 'auditor', 'admin'];

export default async function MembersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactNode> {
  const { context, host, token } = await getPageContext();
  const principal = { permissions: context.permissions };
  const canRead = hasPermission(principal, 'members:read');
  const canInvite = hasPermission(principal, 'members:invite');
  const canRemove = hasPermission(principal, 'members:remove');
  const members = canRead ? await listMembers(token, host).catch(() => []) : [];
  const error = await firstParam(searchParams, 'error');
  const ok = await firstParam(searchParams, 'ok');

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Equipo</p>
          <h1>Miembros</h1>
          <p className="lede">Personas con acceso a {context.organization.name} y su rol.</p>
        </div>
      </div>

      {ok === 'invited' ? (
        <Alert tone="success" title="Invitación creada">
          La persona recibirá un enlace para aceptar la invitación.
        </Alert>
      ) : null}
      {ok === 'removed' ? (
        <Alert tone="success" title="Miembro eliminado">
          El acceso a esta organización se revocó.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" title="No se pudo completar la acción">
          {ERRORS[error] ?? 'Se produjo un error inesperado.'}
        </Alert>
      ) : null}

      {!canRead ? (
        <EmptyState title="Sin acceso a miembros">
          Tu rol no incluye <span className="mono">members:read</span>.
        </EmptyState>
      ) : members.length === 0 ? (
        <EmptyState title="No hay miembros visibles" />
      ) : (
        <div className="table-wrap" role="region" aria-label="Miembros" tabIndex={0}>
          <table>
            <caption>Miembros activos e invitados de la organización.</caption>
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Correo</th>
                <th scope="col">Rol</th>
                <th scope="col">Estado</th>
                {canRemove ? <th scope="col">Acciones</th> : null}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isSelf = member.userId === context.user.id;
                return (
                  <tr key={member.id}>
                    <td>
                      {member.displayName ?? member.userId}
                      {isSelf ? <span className="muted small"> (tú)</span> : null}
                    </td>
                    <td className="muted">{member.email ?? '—'}</td>
                    <td>
                      <RoleBadge role={member.role} />
                    </td>
                    <td>
                      <StatusBadge status={member.status} />
                    </td>
                    {canRemove ? (
                      <td>
                        {isSelf ? (
                          <span className="muted small">—</span>
                        ) : (
                          <form action={removeMemberAction} className="inline-form">
                            <input type="hidden" name="membershipId" value={member.id} />
                            <SubmitButton
                              className="button button-danger"
                              pendingLabel="Eliminando…"
                            >
                              Eliminar
                            </SubmitButton>
                          </form>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canInvite ? (
        <section className="section card" aria-labelledby="invitar-miembro">
          <h2 id="invitar-miembro">Invitar miembro</h2>
          <p className="muted small">
            La invitación caduca en 48 horas. Solo owner y admin pueden invitar.
          </p>
          <form action={inviteMemberAction} className="form-grid">
            <div className="field">
              <label htmlFor="invite-email">Correo electrónico</label>
              <input
                id="invite-email"
                name="email"
                type="email"
                required
                maxLength={320}
                autoComplete="email"
              />
            </div>
            <div className="field">
              <label htmlFor="invite-role">Rol</label>
              <select id="invite-role" name="role" defaultValue="operator">
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>
            <SubmitButton pendingLabel="Invitando…">Enviar invitación</SubmitButton>
          </form>
        </section>
      ) : null}
    </div>
  );
}
