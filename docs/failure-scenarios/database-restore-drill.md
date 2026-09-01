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

Date: 2026-08-20

Commit: ff3f15d

Archive size: 25,605 bytes, custom format

Target database: platform_restore_20260820T204119_a1abe3210e

RTO: approximately 2.04 seconds from dump start to verification

Result: PASS — row counts and migration history matched; 5 RLS policies
were verified; zero pending migrations remained; temporary database removed.

Follow-up: repeat with representative non-empty tenant data before staging.
