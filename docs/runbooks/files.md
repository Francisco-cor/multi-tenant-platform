# Runbook — Archivos S3 (Fase 6)

## Objetivo

Subir/descargar sin proxar bytes, sin cruzar tenants y con retención de huérfanos.

## Contratos

- `POST /v1/files/presigned-upload` → `201 {file:{id,status=pending,expiresAt}, upload:{url,expiresAt: now+300s, headers}}` . Requiere `files:upload`, host tenant, `filename` 1..255 sin `/\..`, `contentType` allowlist, `size` 1..52428800.
- `PUT <upload.url>` directo a S3/MinIO (fuera de API). No se loguea.
- `POST /v1/files/:id/finalize` → `200 {file:{status=ready}}` o `410` si expiró, `404` si otro tenant, `409` si no pending. Idempotente.
- `GET /v1/files/:id` → metadata (sin URL). `404` cross-tenant idéntico a no existe, `410` si expired.
- `GET /v1/files/:id/download` y `/v1/files/:id/presigned-download` → `200 {download:{url,expiresAt: now+60s}}` si `ready`, `409` si pending, `410` si expired.
- `GET /v1/files?limit=&cursor=` → lista tenant-scoped.
- Keys S3: `tenants/{tenantId}/{fileId}` (uuid), nunca exponer key arbitraria.

## Verificación rápida

```bash
# login como acme
curl -i http://localhost:4000/v1/auth/dev-login -H 'content-type: application/json' -d '{"userId":"user-acme-only"}' -c /tmp/cookie_acme

# presign
curl -s http://localhost:4000/v1/files/presigned-upload -H 'host: acme.app.localhost' -H 'content-type: application/json' -b /tmp/cookie_acme \
  -d '{"filename":"demo.pdf","contentType":"application/pdf","size":1024}' | jq

# PUT real (con MinIO up)
UPLOAD_URL=$(curl -s ... | jq -r .upload.url)
curl -i -X PUT "$UPLOAD_URL" -H 'content-type: application/pdf' --data-binary @demo.pdf

# finalize
FILE_ID=$(curl -s ... | jq -r .file.id)
curl -s http://localhost:4000/v1/files/$FILE_ID/finalize -X POST -H 'host: acme.app.localhost' -b /tmp/cookie_acme -H 'content-type: application/json' -d '{}' | jq

# download
curl -s http://localhost:4000/v1/files/$FILE_ID/download -H 'host: acme.app.localhost' -b /tmp/cookie_acme | jq
```

Cross-tenant debe dar 404 aunque se conozca uuid.

## Fallos

| Señal                                    | Causa                                              | Recuperación                                                    |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `400 invalid filename/contentType/size`  | Validación                                         | Corregir allowlist/tamaño                                       |
| `404` al leer/finalize de B con cookie A | RLS + repo tenant-scoped (esperado)                | No revelar existencia                                           |
| `409 FILE_NOT_READY` en download         | No se hizo finalize                                | Hacer finalize primero                                          |
| `410 GONE`                               | `expires_at <= now()` (24h) o presign 5min vencido | Pedir nuevo presign                                             |
| `S3 indisponible` (head falla)           | MinIO caído                                        | finalize sigue tenant-scoped (skip HEAD), GC reintentará delete |

## GC huérfanos

- Job `apps/worker/src/jobs/gcFiles.ts` cada hora (o manual):
  ```bash
  pnpm --filter @platform/worker exec tsx -e "import {createDatabase} from '@platform/db'; import {gcFiles} from './src/jobs/gcFiles.js'; import {FakeS3Service} from '../../apps/api/src/s3.js'; const db=createDatabase(process.env.DATABASE_URL,{role:'platform_app'}); await gcFiles(db,new FakeS3Service(),{batchSize:100});"
  ```
- Busca `pending` expirados `LIMIT 100 FOR UPDATE SKIP LOCKED`, marca `expired`, hace `DELETE` S3 best-effort. Métrica `file_expired_total` incrementa por lote.

## Observabilidad

- No loguear `upload.url`/`download.url` completas. Solo `file.id`, `tenant_id`, `size`, `status`. `packages/observability` redacta `*.secret`.
- Dash `Grafana > Files` con `file_pending_age`, `file_expired_total`.

## Estado actual (2026-09-01)

- InMemory: full coverage. Persistent: RLS validado, pero test de integración MinIO real pendiente de `RUN_DB_INTEGRATION=1` con `withMinio()` + `withPostgres()` y `aws-sdk` opcional.
- Evidencia: `apps/api/src/files.test.ts` 5 tests (cross-tenant 404, TTL 300/60, 409 pending, 410 expired, GC).
