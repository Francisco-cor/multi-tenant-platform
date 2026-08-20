# ADR-003: Drizzle ORM con SQL explícito y migraciones expand-contract

- Estado: aceptado para fase de persistencia
- Fecha: 2026-08-20

## Contexto

El sistema necesita RLS, locks, índices concurrentes, constraints compuestos y migraciones backward-compatible. Ocultar SQL importante dificulta revisar esas propiedades.

## Decisión

Usar Drizzle ORM para composición tipada y SQL/migraciones versionadas para las operaciones donde PostgreSQL es parte del diseño. Toda migración debe declarar si es expand, backfill o contract y qué versiones de aplicación soporta.

Las migraciones destructivas no se mezclan con el primer deploy que introduce un cambio. Los backfills son reanudables, acotados por lotes y observables.

## Consecuencias

El equipo debe conocer PostgreSQL y revisar SQL, pero obtiene control sobre RLS, locks e índices. La compatibilidad entre migración y aplicación se prueba con al menos dos versiones de runtime antes de producción.
