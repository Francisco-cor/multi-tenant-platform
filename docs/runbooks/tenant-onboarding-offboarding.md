# Runbook — alta, suspensión y baja de tenant

- Owner: `platform-support` (proceso) + `platform-db` (datos)
- Última revisión: 2026-11-13
- Cadencia: revisión trimestral; cada baja requiere ticket y evidencia
- Estado: el alta y la gestión de miembros tienen API; la suspensión/baja de organización es una operación de plataforma manual

## 1. Alta de tenant

### 1.1 Crear la organización

El usuario autenticado crea la organización y queda como `owner`:

```bash
curl -s -X POST http://localhost:4000/v1/organizations \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"name":"Acme","slug":"acme"}' | jq
```

Verificar:

- `slug` cumple `^[a-z0-9]+(?:-[a-z0-9]+)*$` y no está reservado.
- La organización queda `active`.
- El creador tiene membresía `owner` activa.
- Se creó el evento de auditoría de creación.

### 1.2 Configurar acceso

1. Invitar miembros con `POST /v1/members/invitations` (`members:invite`), rol `owner|admin|manager|operator|auditor`.
2. El invitado acepta con `POST /v1/members/invitations/:token/accept` en el host del tenant.
3. Verificar que el usuario con membresía solo en A no entra a B (`403`).
4. Si el usuario pertenece a varios tenants, debe seleccionar organización (`POST /v1/auth/switch-organization`).

### 1.3 Configurar operación

- Sucursales: `POST /v1/branches` (`branches:create`) con `slug`, `name`, `description?`.
- Inventario: provisionar `products`/`stock_per_branch` mediante el flujo de datos acordado; no hay endpoint de alta masiva en el primer release.
- Archivos: `POST /v1/files/presign` (`files:upload`) y `POST /v1/files/:id/finalize`.
- Webhooks: `POST /v1/webhooks/endpoints` (`webhooks:manage`) con `url` HTTPS y eventos suscritos; guardar el secreto solo en la respuesta `201`.
- API keys M2M: `POST /v1/api-keys` con scopes mínimos; guardar `raw` solo al crear.
- Flags/kill switches: `PUT /v1/flags/:flag` (`owner/admin`).

### 1.4 Verificación de alta

- [ ] `GET /v1/context` responde con organización y rol correctos.
- [ ] `GET /v1/members` no muestra usuarios de otro tenant.
- [ ] `GET /v1/audit` muestra las acciones de alta.
- [ ] Rate limit y cuota inicial revisados.
- [ ] Contacto de soporte y owner registrados en el ticket.

## 2. Suspensión

No hay endpoint para cambiar el estado de una organización. La suspensión es una operación de plataforma:

1. Abrir ticket con motivo, alcance y aprobación (`platform-support` + `platform-security` si es por abuso).
2. Suspender membresías o usuarios afectados mediante la API cuando sea posible (`DELETE /v1/members/:membershipId` o `PATCH` de rol).
3. Para suspender la organización completa, un operador con `platform_auth`/administrador ejecuta el cambio de estado en DB dentro de una transacción auditada. No usar `platform_app`.
4. Revocar API keys (`DELETE /v1/api-keys/:id`) y rotar secretos de webhooks si hay sospecha.
5. Verificar que `GET /v1/context` y las rutas tenant devuelven `403/404`; las sesiones existentes deben dejar de operar.
6. Registrar en auditoría y en el ticket.

No borrar datos durante una suspensión. La suspensión es reversible; la baja no.

## 3. Baja y borrado

### 3.1 Checklist previo

- [ ] Solicitud verificada y aprobada por `owner` del tenant.
- [ ] Sin obligaciones fiscales/legales pendientes (pagos, facturas, retención).
- [ ] Sin `payment_attempts` en `pending|unknown`; si hay, resolver o documentar.
- [ ] Exportación de datos solicitada/entregada si aplica.
- [ ] API keys y webhooks identificados para revocar.
- [ ] Ventana de retención y backup definidas.

### 3.2 Procedimiento

1. Revocar API keys: `DELETE /v1/api-keys/:id` para cada clave.
2. Deshabilitar webhooks: `PATCH /v1/webhooks/endpoints/:id` con `status: disabled` (o borrar según política).
3. Remover miembros: `DELETE /v1/members/:membershipId`, conservando al menos un owner hasta el final.
4. Marcar la organización como `archived`/suspendida mediante operador de plataforma (`platform_auth`), no con `platform_app`.
5. Esperar la ventana de retención documentada (propuesta: 30 días) antes del borrado físico.
6. Borrado físico: solo un operador con credenciales de administración y procedimiento 2-man; las FK `ON DELETE CASCADE` eliminan datos tenant-scoped, pero `audit_log` se conserva según retención y `actor_user_id` pasa a `NULL` con `actor_user_ref`.
7. Confirmar que el login ya no resuelve el tenant (`404`) y que no quedan jobs/archivos huérfanos.
8. Registrar evidencia: ticket, fecha, operador, tablas/objetos afectados, backup previo.

### 3.3 Qué se conserva

- `audit_log` tenant-scoped durante 365 días (luego archivo/borrado con superusuario).
- `platform_audit_log` para eventos globales.
- `orders`/`payment_attempts` según obligación fiscal (7 años propuesto); anonimizar referencias de usuario cuando aplique.
- Backups según la retención de `backup-verification.md`; el borrado lógico no borra backups inmediatamente.

## 4. API keys y secretos

- Una API key se puede revocar con `DELETE /v1/api-keys/:id`; la rotación con `POST /v1/api-keys/:id/rotate` revoca la anterior.
- Los secretos de webhook se rotan con `POST /v1/webhooks/endpoints/:id/rotate-secret` y tienen ventana de 24 h.
- No reutilizar claves entre tenants; el prefijo/hash está tenant-scoped.
- Registrar en auditoría `api_key.revoked`, `api_key.rotated` y `webhook.secret_rotated`.

## 5. Evidencia y revisión

- [ ] Ticket con aprobación y motivo.
- [ ] Estado final de la organización y membresías.
- [ ] API keys y webhooks revocados/deshabilitados.
- [ ] Exportación/entrega de datos si aplica.
- [ ] Borrado físico o fecha programada.
- [ ] Enlaces a auditoría y backup.

## 6. Referencias

- `docs/architecture/identity-and-tenant-context.md`
- `docs/runbooks/data-retention.md`
- `docs/runbooks/gdpr-erasure.md`
- `docs/runbooks/key-rotation.md`
- `docs/permissions-matrix.md`
