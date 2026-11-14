# Failure scenario — PostgreSQL restore drill

## Hypothesis

A custom-format PostgreSQL backup can be restored into an isolated database
without losing rows, migration history or tenant isolation controls.

## Reproduction

Run:

    pnpm --filter @platform/db restore:drill

The command writes a machine-readable result under .artifacts/db/. The
artifact is intentionally ignored by git because it can contain operational
metadata and belongs in the run evidence system.

## Expected signal

- The source and restored row counts match for every identity table.
- The restored migration history matches the source.
- Organizations, memberships, branches, invitations and audit_log have both
  RLS and FORCE RLS enabled.
- The migration runner reports zero pending migrations after restore.
- The temporary database is removed unless --keep-target was requested.

## Evidence

Date: 2026-08-20 (historical)

Commit: omitido a propósito; el artefacto original no se versiona.

Archive size: no se conserva en Git.

Target database: temporal, eliminada al terminar.

RTO: no reutilizar como métrica actual.

Result: PASS histórico con filas mínimas; no demuestra el estado del árbol actual.

Follow-up: repetir con datos representativos y registrar fecha, commit, checksum,
conteos y RTO en `docs/runbooks/backup-verification.md`. No citar esta evidencia
como actual hasta que se repita.
