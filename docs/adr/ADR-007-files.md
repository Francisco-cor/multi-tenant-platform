# ADR-007: Archivos S3 con flujo presigned seguro (tenant-isolated)

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: Fase 6 (PLAN_ELEVACION.md:266, IMPLEMENTATION_PLAN.md:294), `packages/db/migrations/schema/0007_files.sql`, `apps/api/src/file-store.ts`, `apps/api/src/s3.ts`

## Contexto

La plataforma necesita subir/descargar archivos sin convertir la API en proxy (streaming grande a través de Node) y sin permitir cruces entre tenants aunque se conozca un `fileId`. Opciones:

1. **Proxy a través de API** (multipart → S3). Simple de autorizar, pero API copia bytes, duplica ancho de banda y se vuelve punto de saturación.
2. **Presigned URLs** con metadata tenant-scoped. API solo autoriza y emite URLs de corta duración; el cliente habla directo con S3/MinIO. Más piezas (presign + finalize + GC), pero escala y mantiene aislamiento.
3. **URLs públicas firmadas a largo plazo**. Riesgo de filtración y no permite invalidar por tenant.

Se necesita también: content-type allowlist, límite 50 MB, expiración de uploads incompletos, y garantía de que el finalize pertenece al tenant y al upload pendiente.

## Decisión

Elegir **(2) presigned URLs + metadata tenant-scoped**, con:

### Modelo de datos

- `files` (`id uuid PK`, `tenant_id uuid FK organizations`, `owner_id uuid`, `key text UNIQUE NOT NULL`, `filename text 1..255 sin /\\ ni ..`, `content_type 3..127`, `size_expected int 1..50MiB`, `size_actual int nullable`, `status pending|ready|expired|deleted`, `checksum`, `created_at`, `updated_at`, `expires_at` default `now()+24h`).
- Índices: `files_tenant_status_idx (tenant_id, status)`, `files_tenant_owner_idx`, `files_tenant_expires_idx WHERE status='pending'` (para GC).
- RLS: `ENABLE/FORCE`, política `tenant_id = current_setting('app.tenant_id')::uuid` (`files_tenant_isolation`), `GRANT platform_app`.

### S3 key design

- `tenants/{tenantId}/{fileId}` — no adivinable (uuid v4), sin incluir filename original en el path para evitar enumeración/path traversal. El filename se conserva solo en metadata.
- El bucket es por env (`S3_BUCKET`), endpoint configurable (`S3_ENDPOINT`). Las presigned URLs incluyen `X-Amz-Expires` y `X-Amz-Date` y nunca se loguean completas; el logger redacta `*.secret` y el código evita `logger.info(url)`.

### Flujo

1. `POST /v1/files/presigned-upload` (`files:upload`):
   - Zod: `filename` 1..255 sin `/\..`, `contentType` en allowlist (`image/jpeg|png|webp|gif`, `application/pdf|zip|octet-stream`, `text/plain|csv`, `vnd.openxmlformats.*`) + regex fallback, `size` 1..52428800.
   - En `withTenantTransaction`: `INSERT files (pending, expires_at=now()+24h, key=tenants/{tenantId}/{uuid})` y `SELECT`.
   - Genera presigned PUT vía `S3Service.generateUploadUrl(key, contentType, sizeExpected, expires 300s)` → `{url, expiresAt, headers}`.
   - Respuesta `201 {file, upload}`; el `upload.url` es el único lugar donde la key viaja al cliente, y expira en 5 min.

2. Cliente hace `PUT upload.url` directo a MinIO/S3 con `content-type` y `content-length` exactos.

3. `POST /v1/files/:id/finalize` (`files:upload`):
   - `GET files WHERE id=:id AND tenant_id=:tid FOR UPDATE` → si no existe → `404` idéntico a no existe (evita enumeración).
   - Si `status=expired` o `expires_at <= now()` → `410 GONE` (upload expirado, no retriable sin nuevo presign).
   - Si `status=ready` → idempotente `200`.
   - Opcional: `HEAD` a S3 (`s3.headObject(key)`) verifica `contentLength` y `contentType`; si S3 no responde (fake/local) se salta la verificación pero igual se valida tenant.
   - `UPDATE files SET status='ready', size_actual, updated_at=now()`.

4. `GET /v1/files/:id` (`files:read`) → metadata sin URLs, `404` si no pertenece al tenant, `410` si `expired`.

5. `GET /v1/files/:id/download` y `GET /v1/files/:id/presigned-download` (`files:read`):
   - `SELECT` tenant-scoped FOR status → si `pending` → `409 FILE_NOT_READY`, si `expired` → `410`, si no existe → `404`.
   - `S3Service.generateDownloadUrl(key, expires 60s)` → `{url, expiresAt}`.

6. GC huérfanos:
   - Job `gcFiles` (`apps/worker/src/jobs/gcFiles.ts`) cada hora: `SELECT ... WHERE status='pending' AND expires_at <= now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED` → `UPDATE status='expired'` + `s3.deleteObject(key)` best-effort. Idempotente y permite múltiples workers.

### Añadidos

- `GET /v1/files` lista paginada cursor por `created_at` tenant-scoped (usado en tests de aislamiento).
- Legacy `POST /v1/files/presign` alias para compatibilidad con OpenAPI antiguo.
- `FakeS3Service` in-memory para tests/local (`S3_PROVIDER=fake`); `AwsS3Service` firma MinIO/AWS con SigV4 cuando `S3_PROVIDER=s3`. `S3_ENDPOINT`/`S3_BUCKET` reales deben validarse en integración con MinIO y el bucket debe provisionarse fuera del request path.

## Consecuencias

- **Pros:** API no proxya bytes; presigned TTL corto reduce ventana de exfiltración; `tenants/{tenantId}/` evita cross-tenant incluso si se filtra un `key`; RLS + repository `tenantId` + `files_tenant_expires_idx` hacen GC eficiente; finalize idempotente permite retries sin duplicar; tests A/B (`A` no ve file de `B` aunque adivine `uuid`).
- **Contras:** cliente debe hacer dos pasos (presign + PUT + finalize); requiere que frontend maneje 410/409; GC necesita observabilidad (`file_expired_total`, `file_pending_age`).
- **Riesgos mitigados:** path traversal en `filename` rechazado (`Zod` + `CHECK filename !~ [/\\]` + `!~ \.\.`), content-type allowlist evita polyglot uploads, tamaño máximo protege storage, no log de URLs evita leak en logs.

## Validación

- `apps/api/src/files.test.ts` 5 suites: `presigned-upload` key prefix y TTL 300s, `invalid mime/size/path traversal →400`, `cross-tenant 404 + pending 409 + expired 410 + GC`, `finalize idempotente + cross-tenant 404`, `list tenant-scoped + alias presigned-download TTL 60s` — 17 tests API totales pasan.
- `apps/api/src/file-store.ts` `InMemoryFileStore` + `PersistentFileStore` con `withTenantTransaction` + `FOR UPDATE` en finalize.
- `apps/worker/src/jobs/gcFiles.ts` con `FOR UPDATE SKIP LOCKED` y `deleteObject` best-effort.
- `docs/api/openapi.yaml` actualizado con 5 endpoints Files y `docs/runbooks/files.md` + `docs/failure-scenarios/files.md` (pendiente ampliar con evidencia k6/MinIO real en staging).

## Referencias

- `packages/db/migrations/schema/0007_files.sql:1`,
- `apps/api/src/file-store.ts:1` (`MAX_FILE_SIZE 52428800`, `ALLOWED_MIME_TYPES`),
- `apps/api/src/s3.ts:1` (`FakeS3Service`, `buildFakePresignedUrl`),
- `apps/api/src/app.ts:885` (`POST /v1/files/presigned-upload`, `POST /v1/files/:id/finalize`, `GET /v1/files/:id/download`),
- `apps/worker/src/jobs/gcFiles.ts:1`,
- `docs/architecture/tenant-isolation.md:5` (S3 keys tenant-prefixed).
