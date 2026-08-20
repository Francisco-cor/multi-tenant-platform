# Contribuir

## Flujo

1. Relaciona el cambio con una fase, issue o ADR.
2. Mantén el alcance pequeño y conserva la separación entre apps y packages.
3. Ejecuta `pnpm format:check`, `pnpm lint`, `pnpm typecheck` y `pnpm test`.
4. Para cambios tenant-scoped, añade siempre una prueba negativa con dos tenants.
5. Describe migraciones, retries, observabilidad y rollback cuando el cambio los afecte.

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
