# Documentación — índice

- Última revisión: 2026-11-13
- Owner: `platform-architecture` (contenido) + owners de servicio (runbooks)
- Estado actual: `README.md` en la raíz y anexo 2026-11-13 de `IMPLEMENTATION_PLAN.md`

## Empezar aquí

| Documento                                                | Para qué                                             |
| -------------------------------------------------------- | ---------------------------------------------------- |
| [`../README.md`](../README.md)                           | Visión, quickstart y tabla de estado por fase        |
| [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) | Plan histórico + anexo de reconciliación y evidencia |
| [`demo.md`](./demo.md)                                   | Guion de demo/entrevista y claims que no se hacen    |
| [`glossary.md`](./glossary.md)                           | Términos del dominio                                 |
| [`domain-state-machines.md`](./domain-state-machines.md) | Estados de organización, membresía, orden y reserva  |

## Arquitectura

| Documento                                                                                      | Contenido                                             |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`architecture/system-context.md`](./architecture/system-context.md)                           | Componentes, límites y estado real de infraestructura |
| [`architecture/identity-and-tenant-context.md`](./architecture/identity-and-tenant-context.md) | Host, sesión, BFF, roles y rutas de identidad         |
| [`architecture/tenant-isolation.md`](./architecture/tenant-isolation.md)                       | Invariantes, RLS, roles `platform_*` y evidencia      |
| [`architecture/data-ownership.md`](./architecture/data-ownership.md)                           | Clasificación de tablas, auditoría y retención        |
| [`permissions-matrix.md`](./permissions-matrix.md)                                             | Matriz derivada de `ROLE_PERMISSIONS`                 |

## ADRs

| ADR                                                                              | Decisión                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| [`adr/ADR-001-architecture.md`](./adr/ADR-001-architecture.md)                   | Monorepo y fronteras                     |
| [`adr/ADR-002-tenant-isolation.md`](./adr/ADR-002-tenant-isolation.md)           | Repository + RLS + roles                 |
| [`adr/ADR-003-orm-and-migrations.md`](./adr/ADR-003-orm-and-migrations.md)       | Drizzle y SQL explícito                  |
| [`adr/ADR-004-transactional-outbox.md`](./adr/ADR-004-transactional-outbox.md)   | Outbox, relay, dedupe y DLQ              |
| [`adr/ADR-005-payment-saga.md`](./adr/ADR-005-payment-saga.md)                   | Saga de pagos e incertidumbre            |
| [`adr/ADR-006-inventory-concurrency.md`](./adr/ADR-006-inventory-concurrency.md) | Reserva temporal y decremento atómico    |
| [`adr/ADR-007-files.md`](./adr/ADR-007-files.md)                                 | Archivos S3 presigned                    |
| [`adr/ADR-008-webhooks.md`](./adr/ADR-008-webhooks.md)                           | HMAC, dedupe, retries y automatizaciones |
| [`adr/ADR-009-deploy-migrations.md`](./adr/ADR-009-deploy-migrations.md)         | Expand-contract y migraciones por clase  |
| [`adr/ADR-010-cache-rate-limit.md`](./adr/ADR-010-cache-rate-limit.md)           | Cache, rate limit y breakers             |

## Runbooks

| Runbook                                                                                    | Cuándo usarlo                                  |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [`runbooks/incident-response.md`](./runbooks/incident-response.md)                         | Severidades, roles, comunicación y postmortem  |
| [`runbooks/slo-capacity.md`](./runbooks/slo-capacity.md)                                   | SLOs, error budget y capacidad                 |
| [`runbooks/observability.md`](./runbooks/observability.md)                                 | Alerta → traza → logs → DB/worker              |
| [`runbooks/security.md`](./runbooks/security.md)                                           | Alertas de aislamiento, métricas y egress      |
| [`runbooks/egress-ssrf.md`](./runbooks/egress-ssrf.md)                                     | SSRF, DNS pinning y gap de egress proxy        |
| [`runbooks/key-rotation.md`](./runbooks/key-rotation.md)                                   | Clave de webhooks, API keys, Stripe, OIDC y S3 |
| [`runbooks/backup-verification.md`](./runbooks/backup-verification.md)                     | Backup, restore drill, retención y evidencia   |
| [`runbooks/database-restore.md`](./runbooks/database-restore.md)                           | Procedimiento local de restore                 |
| [`runbooks/postgres-migrations.md`](./runbooks/postgres-migrations.md)                     | Migraciones y clases                           |
| [`runbooks/rollback.md`](./runbooks/rollback.md)                                           | Abortar, pausar o hacer roll-forward           |
| [`runbooks/worker-failure.md`](./runbooks/worker-failure.md)                               | Worker caído, job atascado y readiness         |
| [`runbooks/dlq-replay.md`](./runbooks/dlq-replay.md)                                       | Outbox y DLQ                                   |
| [`runbooks/payment-unknown.md`](./runbooks/payment-unknown.md)                             | Pagos `unknown` y reconciliación               |
| [`runbooks/webhooks.md`](./runbooks/webhooks.md)                                           | Endpoints, entregas, replay e inbound          |
| [`runbooks/files.md`](./runbooks/files.md)                                                 | Presign, finalize, descarga y GC               |
| [`runbooks/cache.md`](./runbooks/cache.md)                                                 | Cache, rate limit y breakers                   |
| [`runbooks/data-retention.md`](./runbooks/data-retention.md)                               | Retención, purgas y borrado                    |
| [`runbooks/gdpr-erasure.md`](./runbooks/gdpr-erasure.md)                                   | Erasure manual y límites                       |
| [`runbooks/tenant-onboarding-offboarding.md`](./runbooks/tenant-onboarding-offboarding.md) | Alta, suspensión, baja y API keys              |

## Escenarios de fallo

[`failure-scenarios/`](./failure-scenarios/) contiene hipótesis, inyección, señal esperada y recuperación. Algunos son procedimientos reproducibles, no evidencia reciente. Destacados:

- [`failure-scenarios/inventory-concurrency.md`](./failure-scenarios/inventory-concurrency.md)
- [`failure-scenarios/payment-saga.md`](./failure-scenarios/payment-saga.md)
- [`failure-scenarios/outbox-dedupe.md`](./failure-scenarios/outbox-dedupe.md)
- [`failure-scenarios/worker-restart.md`](./failure-scenarios/worker-restart.md)
- [`failure-scenarios/redis-down.md`](./failure-scenarios/redis-down.md)
- [`failure-scenarios/db-slow.md`](./failure-scenarios/db-slow.md)
- [`failure-scenarios/s3-unavailable.md`](./failure-scenarios/s3-unavailable.md)
- [`failure-scenarios/webhook-out-of-order.md`](./failure-scenarios/webhook-out-of-order.md)
- [`failure-scenarios/deploy-half.md`](./failure-scenarios/deploy-half.md)
- [`failure-scenarios/migration-blocking.md`](./failure-scenarios/migration-blocking.md)
- [`failure-scenarios/database-restore-drill.md`](./failure-scenarios/database-restore-drill.md)

## Seguridad y privacidad

- [`../SECURITY.md`](../SECURITY.md) — política, reporte, headers, CI y rotación.
- [`threat-model.md`](./threat-model.md) — STRIDE, riesgos residuales y gaps.
- [`security/exceptions.md`](./security/exceptions.md) — excepciones de CI.
- [`privacy/gdpr.md`](./privacy/gdpr.md) — derechos y conservación.
- [`privacy/ropa.md`](./privacy/ropa.md) — registro de actividades (borrador).

## Contrato API

- [`api/README.md`](./api/README.md) — contrato, autenticación y gate de conformidad.
- [`api/openapi.yaml`](./api/openapi.yaml) — especificación 3.1; las 65 operaciones implementadas están documentadas y verificadas contra la tabla real de rutas Fastify.
- `pnpm openapi:check` falla ante drift de rutas/métodos, seguridad incompleta o falta de `Idempotency-Key`; el hash es un recordatorio de cambio intencional.

## Verificación

```bash
node scripts/check-docs-links.mjs
pnpm format:check
pnpm openapi:check
```

El link checker valida enlaces Markdown relativos y rutas citadas con prefijos de repo (`docs/`, `apps/`, `packages/`, `scripts/`, `infra/`, `k6/`, `.github/`).
