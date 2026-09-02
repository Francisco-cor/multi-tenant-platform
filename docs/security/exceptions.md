# Excepciones de seguridad — lista explícita (CI)

- Fecha: 2026-09-01
- Revisión: cada PR que toque `tenant/auth/storage/webhooks` debe actualizar esta lista o corregir el finding.

## Cómo usar

CI jobs `security` en `.github/workflows/ci.yml` corren `pnpm audit`, `gitleaks`, `semgrep`, `CodeQL`, `trivy`. Si un finding es **falso positivo** o **riesgo aceptado**, documentarlo aquí con `ID`, `herramienta`, `severidad`, `justificación` y `fecha de revisión`. No silenciar sin registrar.

## Excepciones actuales

| ID     | Herramienta  | Severidad | Paquete / ruta                                                      | Justificación                                                                                                                                                      | Revisión                                                                                 |
| ------ | ------------ | --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| EX-001 | `pnpm audit` | medium    | `minimatch@9` devDep                                                | Solo en `k6` bundle, no en runtime prod (`platform_app` no usa `minimatch`). Actualizar en próximo `pnpm up`.                                                      | 2026-09-15                                                                               |
| EX-002 | `semgrep`    | low       | `apps/api/src/identity-store.ts:332` `getMembership` overload `any` | Overload tipado intencional para compat `string                                                                                                                    | StoreTenantContext`; no es `any`inseguro. Falso positivo`javascript.lang.security.audit` | 2026-09-15 |
| EX-003 | `gitleaks`   | low       | `docs/api/openapi.yaml` `example: USD`                              | No es secreto; pattern `GENERIC_API_KEY` sobre `apiVersion: v1`. Allowlist `gitleaks.toml` `allowlist: openapi.yaml`.                                              | 2026-09-01                                                                               |
| EX-004 | `trivy fs`   | medium    | `docker-compose.yml:22 redis:7-alpine` `CVE-2023-...`               | Solo en dev `docker-compose`, no en imágenes prod `node:24-alpine` multi-stage non-root. Seguimiento vía `apps/api/Dockerfile` digest `node:24-alpine@sha256:...`. | 2026-09-15                                                                               |
| EX-005 | `CodeQL`     | info      | `apps/api/src/webhook-store.ts:60 validateUrl` `url.startsWith`     | CodeQL sugiere `SSRF` si solo `startsWith https`; mitigado con `private_blocked` + `username` block + timeout. Falso positivo tras hardening Fase 11.              | 2026-09-01                                                                               |

## Procedimiento para nueva excepción

1. Reproducir local: `pnpm audit --prod`, `gitleaks detect --source .`, `semgrep --config p/security-audit`, `trivy fs --severity HIGH,CRITICAL .`
2. Evaluar: ¿afecta `platform_app` (`apps/api` `FE` prod) o solo dev/test? ¿hay fix `pnpm up` inmediato? Si no, registrar aquí con `Próxima revisión ≤30d`.
3. Añadir `allowlist` mínimo: `.gitleaks.toml`, `.semgrepignore`, `trivy.yaml` con `ignore: CVE-...` + comentario `EX-00X`.

## Sin excepciones críticas

No hay excepciones `CRITICAL` o `HIGH` que afecten aislamiento tenant, audit, webhooks o pagos. Cualquier `CRITICAL` debe bloquear merge.
