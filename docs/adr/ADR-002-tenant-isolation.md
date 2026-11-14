# ADR-002: Aislamiento por contexto, repository layer y RLS

- Estado: aceptado; implementación endurecida y verificada el 2026-11-13
- Fecha: 2026-08-20

## Contexto

Un filtro olvidado en un endpoint puede exponer datos entre organizaciones. La autorización en UI o un `tenant_id` enviado por cliente no son garantías suficientes.

## Decisión

Aplicar defensa en profundidad:

1. middleware resuelve host, identidad y membresía;
2. policies comprueban roles/permisos;
3. repositories exigen contexto tenant explícito y filtran por `tenant_id`;
4. tablas tenant-scoped usan constraints, índices y relaciones consistentes;
5. PostgreSQL RLS usa el tenant de la transacción como barrera final;
6. jobs, cache, object storage y auditoría transportan/validan el contexto.

El `tenant_id` del body nunca sobrescribe el del contexto. Los endpoints cross-tenant administrativos, si existen, serán una superficie separada con permisos globales.

La implementación actual separa roles: `platform_app` (negocio tenant), `platform_auth` (credenciales), `platform_worker` (relay global) y `platform_auditor` (lectura de auditoría global). Las sesiones se atan al usuario con `app.user_id`, no solo al tenant.

## Consecuencias

Hay más código explícito y pruebas de integración, además de cuidado con pools de conexiones y `SET LOCAL`. A cambio, un bug de routing no debe convertirse automáticamente en una fuga de datos. La implementación fue validada con pool concurrente (`isolation.concurrent.test.ts`), RLS directa (`isolation.rls.test.ts`) y la suite de integración de CI. El detalle vigente está en `docs/architecture/tenant-isolation.md` y `IMPLEMENTATION_PLAN.md` (anexo 2026-11-13).
