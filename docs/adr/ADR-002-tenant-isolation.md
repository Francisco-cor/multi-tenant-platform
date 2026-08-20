# ADR-002: Aislamiento por contexto, repository layer y RLS

- Estado: aceptado
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

## Consecuencias

Hay más código explícito y pruebas de integración, además de cuidado con pools de conexiones y `SET LOCAL`. A cambio, un bug de routing no debe convertirse automáticamente en una fuga de datos. La Fase 3 validará el comportamiento de RLS con pool y transacciones reales.
