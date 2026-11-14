# Runbook — retención y borrado de datos

- Owner: `platform-security` + `platform-db`
- Última revisión: 2026-11-13
- Cadencia: revisión trimestral; ejecución de purgas según tabla
- Estado: helpers de purga en `packages/db`; **no hay cron desplegado** para audit/outbox/DLQ

## 1. Clasificación y retención

| Tabla                                                                           | Clase                                | Retención lógica                                          | Borrado                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `users`                                                                         | global                               | Mientras haya membresía activa; tras erasure, anonimizado | Operador de plataforma                                           |
| `organizations`                                                                 | tenant root                          | Activa; archivada/suspendida antes de baja                | Operador de plataforma; cascada solo tras retención              |
| `memberships`                                                                   | tenant-scoped                        | Mientras vigente; `removed` es soft                       | Cascada de organización                                          |
| `branches`                                                                      | tenant-scoped                        | Activa/archivada                                          | Cascada de organización                                          |
| `audit_log`                                                                     | tenant-scoped (`tenant_id NOT NULL`) | 365 días                                                  | Archivo + borrado con superusuario; trigger impide DELETE normal |
| `platform_audit_log`                                                            | global                               | 365 días (propuesta)                                      | Operador de plataforma                                           |
| `sessions`                                                                      | user-bound                           | 8 h deslizante + límite absoluto                          | `purgeExpiredSessionsUntilEmpty` (helper)                        |
| `invitations`                                                                   | tenant-scoped                        | 48 h                                                      | GC/expiración                                                    |
| `products`, `stock_per_branch`, `inventory_reservations`, `inventory_movements` | tenant-scoped                        | Reservas 15 min; movimientos append-only                  | Retención según tenant                                           |
| `files`                                                                         | tenant-scoped                        | `pending` 24 h; `ready` según tenant                      | `gcFiles` + S3 delete                                            |
| `outbox_events`                                                                 | tenant-scoped                        | 7 días para `done`/`dead_letter`                          | `purgeOutboxEvents` (helper)                                     |
| `processed_jobs`                                                                | tenant-scoped                        | 7 días para `completed`                                   | `purgeProcessedJobs` (helper)                                    |
| `dlq_jobs`                                                                      | tenant-scoped                        | 30 días para `replayed`/`discarded`                       | `purgeDlqJobs` (helper)                                          |
| `webhook_deliveries`                                                            | tenant-scoped                        | 30 días para estados terminales                           | `purgeWebhookDeliveries` (helper)                                |
| `orders`, `payment_attempts`, `inbound_payment_events`                          | tenant-scoped                        | 7 años fiscal (propuesto)                                 | Operador de plataforma                                           |
| `webhook_endpoints`, `inbound_webhook_events`, `api_keys`, `automations`        | tenant-scoped                        | Según baja/expiración                                     | API/operador                                                     |

Las cifras de retención son política, no una garantía de que exista un job. `packages/db/src/jobs/retention.ts` implementa purgas por lotes con `dryRun`; `purgeExpiredSessionsUntilEmpty` está en `packages/db/src/jobs/purgeSessions.ts`. Ninguna está cableada al scheduler del worker actualmente.

## 2. Auditoría

- `audit_log` es append-only: `REVOKE UPDATE,DELETE` + triggers `audit_log_no_update`/`audit_log_no_delete` (`45000`).
- `platform_app` solo `SELECT,INSERT`; no puede `TRUNCATE`.
- Los eventos globales están en `platform_audit_log`, separados para que un tenant no los lea ni los falsifique.
- `GET /v1/audit` requiere `audit:read` (`owner/admin/manager/auditor`), pagina por cursor `at|id` y no cruza tenants.
- El borrado físico de auditoría requiere superusuario, `DISABLE TRIGGER`, archivo previo y procedimiento 2-man. No se hace desde la API.

## 3. Purga de outbox, DLQ y webhooks

```bash
# Dry run (no borra)
pnpm --filter @platform/db exec tsx -e "import {createAdminDatabase,runRetentionSweep} from '@platform/db'; const h=createAdminDatabase(process.env.DATABASE_URL); console.log(await runRetentionSweep(h.db,{dryRun:true})); await h.close();"

# Ejecución (requiere conexión admin; platform_app no puede borrar estas filas)
pnpm --filter @platform/db exec tsx -e "import {createAdminDatabase,runRetentionSweep} from '@platform/db'; const h=createAdminDatabase(process.env.DATABASE_URL); console.log(await runRetentionSweep(h.db,{batchSize:1000,maxBatches:10})); await h.close();"
```

Registrar conteos antes/después y no ejecutar durante un incidente de outbox/DLQ.

## 4. Borrado de tenant

- No existe `DELETE /v1/organizations/:id`; la baja es una operación de plataforma.
- Revocar API keys, deshabilitar webhooks y remover miembros primero (`tenant-onboarding-offboarding.md`).
- Marcar la organización como `archived`/`suspended` (no `deleted`; ese estado no existe en el dominio actual).
- Esperar la retención aprobada y hacer el borrado con credenciales administrativas y 2-man.
- `audit_log` no se borra en cascada; se conserva y se archiva según retención.

## 5. Erasure de usuario

Ver `docs/runbooks/gdpr-erasure.md`. Resumen: no hay endpoint formal ni worker `anonymize_user`; el procedimiento es manual, no puede `UPDATE audit_log` por el trigger y debe preservar obligaciones fiscales.

## 6. Checklist operativo

- [ ] Purga de outbox/DLQ/webhooks ejecutada con dry-run previo.
- [ ] Conteos y duración registrados.
- [ ] `audit_log` sin intención de UPDATE/DELETE.
- [ ] Backups y retención revisados antes de un borrado de tenant.
- [ ] Evidencia en el ticket.

## 7. Referencias

- `packages/db/src/jobs/retention.ts`, `packages/db/src/jobs/purgeSessions.ts`.
- `docs/runbooks/database-restore.md`, `backup-verification.md`.
- `docs/runbooks/tenant-onboarding-offboarding.md`, `gdpr-erasure.md`.
- `docs/privacy/gdpr.md`, `docs/privacy/ropa.md`.
