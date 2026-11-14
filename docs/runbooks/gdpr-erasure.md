# Runbook — GDPR erasure (derecho al olvido)

- Owner: `platform-security` + `platform-support`
- Última revisión: 2026-11-13
- Estado: procedimiento manual; no hay endpoint `POST /v1/admin/gdpr/erasure` ni worker `anonymize_user`

## 1. Precondiciones

- Solicitud escrita verificada (art. 17): identidad, `email`, `oidc_subject` y tenant.
- Aprobación del `owner` del tenant y, si hay `legal_hold`, de `platform-security`.
- Sin `payment_attempts` en `pending|unknown` que impidan reconciliar; si existen, resolver o documentar.
- Ticket con alcance, base legal y fecha límite (30 días).

## 2. Alcance

| Dato                          | Acción                        | Límite                                              |
| ----------------------------- | ----------------------------- | --------------------------------------------------- |
| `users.email`, `display_name` | Anonimizar                    | El `id` se conserva por FK                          |
| `users.oidc_subject`          | Reemplazar por `deleted:<id>` | Coordinar con el IdP                                |
| `memberships`                 | `active=false`/`removed`      | Mantener trazabilidad                               |
| `files.owner_id`              | `NULL`                        | Los bytes se borran por GC/tenant                   |
| `sessions`                    | Borrar/expirar                | No dejar sesión viva                                |
| `invitations`                 | Borrar/expirar                | Contienen email                                     |
| `api_keys`                    | Revocar                       | `DELETE /v1/api-keys/:id`                           |
| `audit_log`                   | **No modificar ni borrar**    | Append-only; retención 365 días                     |
| `orders`/`payment_attempts`   | Conservar importe/estado      | Obligación fiscal; anonimizar referencias si aplica |

## 3. Procedimiento

### 3.1 Verificar identidad y membresía

```bash
curl -s http://localhost:4000/v1/members \
  -H 'host: acme.app.localhost' \
  -H "authorization: Bearer $OWNER_TOKEN" | jq '.data[] | select(.userId=="<user-id>")'
```

Confirmar que el usuario pertenece al tenant y que el solicitante es `owner`.

### 3.2 Revocar accesos

1. Revocar API keys del usuario/tenant que correspondan (`DELETE /v1/api-keys/:id`).
2. Remover membresías con la API (`DELETE /v1/members/:membershipId`) o marcarlas inactivas; conservar un owner.
3. Invalidar sesiones: el borrado/expiración se hace con el helper `purgeExpiredSessionsUntilEmpty` o esperando el límite absoluto. No hay endpoint de “cerrar todas las sesiones”.

### 3.3 Anonimizar identidad (operador de plataforma)

El cambio de `users` es una operación de plataforma, no de `platform_app` (ese rol no puede tocar `oidc_subject` ni todas las columnas). Usar una conexión administrativa, en transacción y con revisión 2-man:

```sql
begin;
-- Ejecutar con credenciales administrativas, nunca con platform_app.
update users
set email = 'anonymized-' || substr(md5(id::text), 1, 8) || '@example.invalid',
    display_name = 'Deleted User',
    oidc_subject = 'deleted:' || id,
    active = false,
    updated_at = now()
where id = '<user-id>'::uuid;

update memberships
set active = false, updated_at = now()
where user_id = '<user-id>'::uuid and tenant_id = '<tenant-id>'::uuid;

update files
set owner_id = null, updated_at = now()
where owner_id = '<user-id>'::uuid and tenant_id = '<tenant-id>'::uuid;

commit;
```

No ejecutar `UPDATE audit_log` ni `DELETE FROM audit_log`: los triggers lo bloquean y la auditoría debe conservarse. Si se necesita pseudonimizar metadata, se hace en una nueva versión del modelo, no editando historia.

### 3.4 Registrar y verificar

- Registrar la solicitud y la ejecución en el ticket; si se dispone de un endpoint de auditoría, crear el evento con el servicio correspondiente.
- Verificar:

```bash
psql "$DATABASE_URL" -c "select id, email, display_name, active from users where id='<user-id>'"
# -> anonymized-... | Deleted User | f
psql "$DATABASE_URL" -c "select count(*) from memberships where user_id='<user-id>' and active"
# -> 0
psql "$DATABASE_URL" -c "select count(*) from files where owner_id='<user-id>'"
# -> 0
```

- Confirmar que el usuario no puede autenticarse y que no hay sesiones activas.
- Notificar al interesado y archivar el ticket (3 años, fuera de DB).

## 4. Qué no hacer

- No borrar `audit_log` ni deshabilitar triggers sin procedimiento 2-man.
- No borrar `orders`/`payment_attempts` con obligación fiscal.
- No reutilizar el `id` del usuario para una nueva identidad.
- No ejecutar el SQL con `platform_app`; fallará o quedará incompleto.

## 5. Rollback

La anonimización no es reversible. Si se ejecutó por error, crear una identidad nueva con nuevo `oidc_subject`, re-invitar y documentar el incidente. No intentar “restaurar” el email desde backups sin aprobación legal.

## 6. Checklist

- [ ] Solicitud y aprobación registradas.
- [ ] API keys y membresías revocadas.
- [ ] `users` anonimizado y `active=false`.
- [ ] `files.owner_id` nulo y sesiones invalidadas.
- [ ] `audit_log` intacto.
- [ ] Verificación SQL y ticket archivado.

## 7. Gaps

- Endpoint formal de erasure y worker `anonymize_user` no implementados.
- Exportación/portabilidad (`GET /v1/audit/export`) no implementada.
- ROPA en `docs/privacy/ropa.md`; revisión legal pendiente.
