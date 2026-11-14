# Excepciones de seguridad — lista explícita

- Última revisión: 2026-11-13
- Owner: `platform-security`
- Regla: cada PR que toque `tenant/auth/storage/webhooks` actualiza esta lista o corrige el finding

## Cómo usar

El job `security` de `.github/workflows/ci.yml` ejecuta `pnpm audit`, gitleaks, Semgrep y Trivy; CodeQL es condicional. Si un finding es falso positivo o riesgo aceptado, se documenta aquí con `ID`, herramienta, severidad, ruta, justificación y fecha de revisión. No se silencia sin registrar.

No hay archivos `.gitleaks.toml`, `.semgrepignore` ni `trivy.yaml` versionados actualmente; si se añaden allowlists, deben ser mínimas y referenciar el `EX-*`.

## Excepciones actuales

| ID     | Herramienta  | Severidad | Ruta / paquete                                               | Justificación                                                                                                                                        | Revisión   |
| ------ | ------------ | --------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| EX-001 | `pnpm audit` | medium    | `minimatch@9` (dev)                                          | Solo en tooling de `k6`/dev; no se carga en runtime de API/worker. Actualizar en el próximo `pnpm up`.                                               | 2026-12-13 |
| EX-002 | `semgrep`    | low       | `apps/api/src/identity-store.ts` overload de `getMembership` | Overload tipado intencional para compatibilidad `string \| StoreTenantContext`; no es un `any` inseguro. Falso positivo.                             | 2026-12-13 |
| EX-003 | `gitleaks`   | low       | `docs/api/openapi.yaml` ejemplos `USD`/`v1`                  | No son secretos; el escaneo puede marcarlos como patrones genéricos. No se ha añadido allowlist versionada.                                          | 2026-12-13 |
| EX-004 | `trivy fs`   | medium    | Dependencias de desarrollo e imágenes de Compose             | Solo afecta a dev/test; las imágenes de runtime usan Node 24 multi-stage no-root. Revisar digest al actualizar.                                      | 2026-12-13 |
| EX-005 | `CodeQL`     | info      | `apps/api/src/webhook-store.ts` `validateUrl`                | CodeQL sugiere SSRF por `startsWith('https')`; hay bloqueo de rangos privados, DNS pinning en el worker y timeout. Falso positivo tras el hardening. | 2026-12-13 |

## Procedimiento para una nueva excepción

1. Reproducir local: `pnpm audit --prod`, `gitleaks detect --source .`, `semgrep scan --config p/security-audit`, `trivy fs --severity HIGH,CRITICAL .`.
2. Evaluar si afecta a runtime (`apps/api`, `apps/worker`, `apps/web`) o solo a dev/test; si hay fix, aplicarlo antes de aceptar.
3. Registrar aquí con revisión ≤30 días y, si se añade allowlist, mantenerla mínima y comentada con el `EX-*`.
4. No aceptar excepciones `CRITICAL` o `HIGH` que afecten aislamiento tenant, auditoría, webhooks o pagos.
