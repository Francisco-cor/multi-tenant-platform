# Contribuir

## Flujo

1. Relaciona el cambio con una fase, issue o ADR.
2. Mantén el alcance pequeño y conserva la separación entre apps y packages (`packages/*` no importa `apps/*` — verificado por `eslint-plugin-import`).
3. Ejecuta `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm build`, `pnpm openapi:check` y `node scripts/check-docs-links.mjs` antes de push. La integración real requiere servicios y corre en CI.
4. Para cambios tenant-scoped, añade siempre una prueba negativa con dos tenants (usa `@platform/testing` + `withPostgres()` si necesitas DB real).
5. Si tocas contratos HTTP, actualiza `docs/api/openapi.yaml` y el hash: `pnpm openapi:check` imprime el valor y el comando `echo <hash> > docs/api/.openapi.hash`; no lo genera automáticamente.
6. Describe migraciones (`schema/` vs `data/` vs `indexes/` + `CONCURRENTLY`), retries, observabilidad y rollback cuando el cambio los afecte.
7. Verifica Docker builds si tocas `Dockerfile` o `tsconfig.build.json`: `docker build -f apps/<app>/Dockerfile -t test:local .`
8. No presentes una fase como cerrada sin evidencia de CI; el estado vive en `README.md` y el anexo de `IMPLEMENTATION_PLAN.md`.

## Commits

Usamos Conventional Commits:

```text
<type>(<scope>): <imperative summary>
```

Tipos habituales: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`.

Ejemplos:

- `feat(domain): define initial organization permissions`
- `test(isolation): reject cross-tenant resource reads`
- `docs(adr): record transactional outbox decision`
