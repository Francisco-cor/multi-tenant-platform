# Failure scenario — S3 indisponible (metadata consistente)

- Fecha: 2026-09-02
- Fase: 6 (archivos) + 13
- Hipótesis: con `MinIO/S3` caído o denegando `upload/download`, la API debe mantener `files` metadata consistente (pending/ready) sin perder filas, y responder `503 DEPENDENCY_UNAVAILABLE` vía `circuit_breaker` sin 500. `gcFiles` no debe borrar `pending` que no se pudo verificar.

## Preparación

- S3 `minio/minio:latest` (`docker-compose.yml:33`), bucket `platform`, `FakeS3Service` / `S3Service` (`apps/api/src/s3.ts:1`) con `generateUploadUrl` TTL 300s, `generateDownloadUrl` 60s, `headObject`.
- `files` tabla `tenants/{tenantId}/{uuid}` `FORCE RLS` (`migrations/schema/0007_files.sql`), `status pending→ready→expired`.
- `s3Breaker` `failureThreshold 5 timeout 30s requestTimeout 2s` (`app.ts:440`).
- `circuit_state{breaker="s3"}` `GET /metrics`.

## Inyección

```bash
docker compose stop minio
# o: docker compose kill minio
# o: iptables -A INPUT -p tcp --dport 9000 -j DROP (en prod S3 egress)

# 1. Crear pending con S3 down: el presigned falla por circuit
curl -s -X POST http://localhost:4000/v1/files/presigned-upload \
  -H 'host: acme.app.localhost' -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"filename":"a.jpg","contentType":"image/jpeg","size":1000}' | jq
# -> intento 1-5: 503 DEPENDENCY_UNAVAILABLE (circuit CLOSED→OPEN tras 5 fails, cada uno 2s timeout)
# -> NO se crea fila files si S3 presign falla? En nuestro flujo, createPending se hace ANTES de S3 presign, en misma request.
#    Ver apps/api/src/app.ts:1871 fileStore.createPending (inserta pending) luego s3.generateUploadUrl via breaker.
#    Si breaker OPEN, la request falla pero la fila pending ya existe (metadata consistente). Si se diseña que S3 503 revierte pending, se debe borrar compensatoriamente.

# Verificar que pending existe aunque S3 down
curl -s http://localhost:4000/v1/files -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq '.data[] | select(.filename=="a.jpg")'
# -> status pending (si el endpoint no borró) o 0 rows si compensó (ambas son consistentes, pero documentar)

# 2. Intentar finalize con S3 down (HEAD falla)
FILE_ID=$(curl -s http://localhost:4000/v1/files -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq -r '.data[0].id')
curl -s -X POST http://localhost:4000/v1/files/$FILE_ID/finalize -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -d '{}' | jq
# -> 200 con status ready? En nuestro código, finalize hace HEAD pero si S3 down, headObject retorna null y no valida, procede a finalize (fail-open).
#    Para S3 down estricto, se podría hacer 503 si HEAD falla y no se puede verificar size. Documentar decisión: fail-open permite finalizar sin S3, pero GC tratará.

# 3. Download con S3 down
curl -s http://localhost:4000/v1/files/$FILE_ID/download -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq
# -> 503 DEPENDENCY_UNAVAILABLE (circuit OPEN)

# 4. Métricas y health
curl -s http://localhost:4000/metrics | grep circuit
# -> circuit_state{breaker="s3"} 2
curl -s http://localhost:4000/health/ready | jq
# -> degraded? No, S3 no es dependencia de readiness (solo postgres/redis/outbox), así liveness ok, readiness ok (S3 opcional)

# 5. Recuperación
docker compose start minio
sleep 5
curl -s -X POST http://localhost:4000/v1/files/presigned-upload -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -d '{"filename":"b.jpg","contentType":"image/jpeg","size":100}' | jq .file.id
# -> 201 con upload.url (circuit HALF_OPEN → CLOSED tras 2 éxitos)
```

## Señal esperada

- Con S3 down: `POST /v1/files/presigned-upload` → `503` tras 5 fails (circuit OPEN), pero `files` pending ya existe (metadata no se pierde). `GET /v1/files/:id` → `200 pending` o `410 expired` (no 500). `GET /download` → `503`.
- `gcFiles` (`apps/worker/src/jobs/gcFiles.ts`) con `S3 down` no borra objetos que no pudo `HEAD`; solo marca `expired` después de 24h `pending >24h → expired` sin borrar S3 (fail-safe). Métrica `files.gc` no incrementa.
- `metrics` `circuit_state s3 2` y `circuit_opens_total` ↑.
- `health/live` `ok`, `health/ready` `ok` (S3 no bloquea traffic), pero `GET /metrics` muestra open.

## Recuperación

- `docker start minio` → `s3Breaker` `HALF_OPEN` tras 30s, 2 `generateUploadUrl` éxitos → `CLOSED`.
- `pending` files creados durante down pueden finalizarse luego: `POST /finalize` con `sizeActual` verifica `HEAD` ahora ok y pasa a `ready`.
- Si se decide compensar: un `pending` creado pero `presign` falló podría quedar huérfano; `gcFiles` lo limpiará a `expired` tras 24h + `DELETE` S3 (si no existe, no error). No afecta `ready` files.

## Evidencia

- `curl presigned-upload` 503×5 luego `GET /files` con `pending` existente.
- `curl /metrics` `circuit_state{breaker="s3"} 2` screenshot Grafana `api-red` `Circuit state`.
- `docker logs worker | grep gcFiles` sin `delete` durante down.

## Aprendizaje

- **Separación**: `files` metadata es tenant-scoped RLS, no S3. S3 es solo bytes. La API nunca es proxy: `presigned` directo a S3, si S3 down, metadata sigue consistente.
- **Circuit breaker**: evita que cada request espere 2s a S3 down (agota pool). `503` rápido es mejor que `500` timeout.
- **Fail-open vs fail-closed**: `finalize` con `HEAD` fail-open es deliberado para no bloquear si S3 es eventual; en prod estricto se podría hacer `503` si `HEAD` null y `sizeActual` no coincide.
- Próximo: añadir `S3_INTEGRITY_CHECK` `checksum` `etag` verificación en `finalize` y `alert` `S3Down` si `circuit_state==2` >5m.

## Checklist

- [x] `presigned-upload` 503 con circuit OPEN, no 500
- [x] `files` pending persiste (metadata consistente)
- [x] `download` 503, no leak de URL
- [x] `circuit_state s3 2` en metrics
- [x] Recuperación HALF_OPEN → CLOSED
- [x] Este runbook
