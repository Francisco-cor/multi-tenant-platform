# Runbook — backup y verificación de restore

- Owner: `platform-db`
- Ejecutor: `platform-db` + `platform-infra`
- Última revisión: 2026-11-13
- Cadencia objetivo: backup diario; restore drill semanal; revisión mensual de retención
- Estado actual: **no hay backup programado en el repositorio**. Existe un comando manual y un restore drill reproducible; la última evidencia versionada es histórica y debe repetirse.

## 1. Objetivos

| Métrica                   | Objetivo propuesto                          | Estado                                   |
| ------------------------- | ------------------------------------------- | ---------------------------------------- |
| RPO                       | <= 15 min en producción                     | No medido; depende del backup gestionado |
| RTO                       | <= 60 min para una base pequeña/mediana     | No medido en producción                  |
| Verificación              | Restore completo semanal en entorno aislado | Manual, no programada                    |
| Retención de backups      | 30 días diarios + 12 mensuales (propuesta)  | No configurada en el repo                |
| Retención lógica de datos | Ver `data-retention.md`                     | Documentada                              |

Los objetivos no son un SLA hasta que exista un backup gestionado y una prueba con datos representativos.

## 2. Backup manual

```bash
mkdir -p .artifacts/db
pnpm --filter @platform/db backup --output .artifacts/db/platform-manual.dump
```

- El comando se niega a sobrescribir un archivo existente.
- Usa `PGPASSWORD` en el proceso hijo; no pone la contraseña en la línea de comandos.
- Si los binarios no están en PATH, definir `PG_DUMP_BIN`/`PG_RESTORE_BIN`.
- Con Compose, `PG_TOOL_CONTAINER` permite usar el contenedor PostgreSQL y dejar el archivo en el host.
- El archivo contiene datos; no se commitea y debe cifrarse en el almacenamiento destino.

## 3. Restore drill

```bash
pnpm --filter @platform/db restore:drill
# Inspección manual opcional:
pnpm --filter @platform/db restore:drill --keep-target
```

El drill:

1. crea un dump custom;
2. crea una base temporal única;
3. restaura con `pg_restore --exit-on-error`;
4. compara conteos de filas e historial de migraciones;
5. verifica `FORCE ROW LEVEL SECURITY` y policies tenant;
6. reejecuta el runner y exige cero migraciones pendientes;
7. escribe evidencia JSON en `.artifacts/db/`;
8. elimina la base temporal con `DROP DATABASE ... WITH FORCE`.

Si falla: no restaurar sobre la base fuente, no editar una migración aplicada y no borrar el artefacto. Registrar el error y escalar a `platform-db`.

## 4. Evidencia que se debe registrar

- Fecha y hora UTC, commit y entorno.
- Archivo, tamaño y checksum.
- Base origen y base temporal.
- Conteos comparados (al menos `users`, `organizations`, `memberships`, `branches`, `audit_log`, `orders`, `payment_attempts`).
- Resultado de RLS `FORCE` y policies.
- Migraciones pendientes (debe ser 0).
- RTO medido y cualquier diferencia.
- Enlace al artefacto JSON (fuera de Git si contiene metadatos operativos).

La evidencia histórica está en `docs/failure-scenarios/database-restore-drill.md`. Se conserva como referencia, pero **no** demuestra el estado actual: repetir el drill y actualizar fecha/commit antes de usarla en una entrevista o release.

## 5. Cadencia y responsables

| Actividad                        | Frecuencia                     | Owner                               | Evidencia                           |
| -------------------------------- | ------------------------------ | ----------------------------------- | ----------------------------------- |
| Backup automático                | Diario (objetivo)              | `platform-infra`                    | Alerta de fallo + objeto en storage |
| Verificación de backup           | Diario                         | `platform-db`                       | Checksum y tamaño                   |
| Restore drill                    | Semanal (objetivo)             | `platform-db`                       | JSON + este runbook                 |
| Prueba con datos representativos | Antes de staging/release mayor | `platform-db`                       | Informe                             |
| Revisión de retención            | Mensual                        | `platform-security` + `platform-db` | Acta                                |

## 6. Producción

- Usar el backup gestionado del proveedor (PITR) además del dump lógico.
- Cifrar backups en reposo y restringir acceso; no usar credenciales de aplicación.
- Probar restore en una cuenta/proyecto aislado, nunca en producción.
- Mantener una copia fuera de la región primaria si el RPO/RTO lo exige.
- Documentar el procedimiento específico del proveedor; este runbook cubre el contrato mínimo.

## 7. Referencias

- `docs/runbooks/database-restore.md` — procedimiento local.
- `docs/runbooks/data-retention.md` — retención lógica.
- `docs/failure-scenarios/database-restore-drill.md` — evidencia histórica.
- `packages/db/src/backup.ts`, `packages/db/src/restore-drill.ts`.
