# System context — estado actual

- Última revisión: 2026-11-13

```text
Usuario
  -> subdominio tenant
  -> Next.js web (middleware de host + BFF server-side)
       -> API Node.js versionada
            -> PostgreSQL: fuente de verdad y aislamiento RLS
            -> Redis: rate limiting, cache reconstruible y BullMQ
            -> S3-compatible: objetos, nunca autorización
            -> OIDC: identidad
            -> proveedores externos: pagos y webhooks
       -> OTel Collector -> métricas, traces y dashboards
```

## Componentes

- **Web:** Next.js App Router. El middleware deriva el slug del `Host`, aplica CSP/no-store y el BFF guarda el token en cookie HttpOnly. La web no decide permisos; consume la API.
- **API:** Fastify. Resuelve host + sesión/membresía, aplica RBAC, valida Zod, limita body y rate, y ejecuta comandos tenant-scoped.
- **Worker:** BullMQ, relay de outbox, jobs de pago, reservas, archivos y webhooks. El relay global usa `platform_worker`; los handlers tenant usan `platform_app`.
- **DB:** PostgreSQL con RLS `FORCE`, roles separados y migraciones versionadas.
- **Redis:** cache, rate limit y colas. No es fuente de verdad; si cae, la API degrada a DB/InMemory donde es seguro.
- **S3/MinIO:** bytes con prefijo `tenants/{tenantId}/`; la autorización vive en la API y la metadata.
- **Observabilidad:** OTel Collector, Prometheus y Grafana locales. `infra/` contiene solo configuración local; Kubernetes y Terraform **no existen todavía**.
- **Pagos:** `FakePaymentProvider` para tests/demo; `StripePaymentProvider` implementado pero no probado contra Stripe real.
- **Webhooks outbound:** DNS pinning y bloqueo de rangos privados en el worker; **no hay egress proxy** con allowlist.

## Límites

- Web no decide permisos: consume capacidades de API.
- API resuelve request context y aplica policies.
- DB protege datos tenant-scoped con filtro de repository y RLS.
- Worker ejecuta efectos asíncronos, pero no inventa un tenant: todo job tenant-scoped transporta tenant ID y correlation ID.
- Storage guarda bytes; metadata, autorización y auditoría viven en la plataforma.
- El contrato OpenAPI describe la intención, no prueba que la ruta exista. Hay drift conocido; ver el addendum de `IMPLEMENTATION_PLAN.md`.
