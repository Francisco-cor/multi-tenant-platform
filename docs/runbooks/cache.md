# Runbook — Cache, rate limiting y resiliencia (Fase 10)

## Objetivo

Operar lecturas cacheables con TTL acotado, límites hot-tenant y degradación segura si Redis o S3 fallan, sin filtrar datos entre tenants.

## Contratos

### Cache

- **Recursos cacheables** (TTL): `branches` 60s, `members` 30s, `inventory?branch=&q=&limit=&cursor=` 30s, `webhooks:endpoints` 60s. Usa `GET /v1/...` con `x-cache: HIT|MISS` + `cache-control: private, max-age=30`.
- **Keys**: `tenant:{tenantId}:v1:{resource}:{hash16}` donde `hash16=sha256(sorted(params)).slice(0,16)`. `tenantId` obligatorio. `v1` permite bump global.
- **Invalidación**: escritura confirmada → `DELETE prefix tenant:{id}:v1:{resource}:*`. TTL asegura no stale >60s si se pierde evento. Nunca cachear `orders/payments` transaccionales.
- **Stampede**: `SET NX PX 5s` lock por key, poll 10×50ms. Métrica `cache_stampede_fallback_total` sube si muchos loaders concurrentes (>50 VUs hot key).

### Rate limiting

- **Límites** (`window 60s`):
  - `ip: 100 req/min` global (abuso, `onRequest`).
  - `tenant: 1000 req/min` (`enforceTenantRateLimit` tras `requireTenantContext`).
  - `user: 200 req/min`.
  - Endpoints sensibles por tenant/IP:
    - `POST /v1/orders` 20/min tenant
    - `POST /v1/inventory/reserve` 30/min tenant
    - `POST /v1/files/presigned-upload` 20/min tenant
    - `POST /v1/webhooks/endpoints` 20/min tenant
    - `POST /v1/auth/dev-login` 10/min IP
- **Headers** en toda respuesta: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (sec). En 429: `retry-after` + `{error:{code:RATE_LIMITED, details:{retryAfter}}}`.
- **Fallo**: si `REDIS_URL` falla → fallback InMemory per-instance (sigue limitando local). Nunca 5xx por Redis. `GET /health/ready` reporta `redis:fail` → `degraded` pero `liveness:ok` y DB sirve fallback.

### Circuit breaker

- **Breakers**: `s3` (5 fallos → OPEN 30s, timeout 2s), `payment` (5→30s/3s), `oidc` (3→60s/2s).
- **Estados**: `CLOSED` normal, `OPEN` fail-fast `503 {code:CIRCUIT_OPEN}`, `HALF_OPEN` probe. Métricas `circuit_opens_total`, `circuit_rejects_total`, `circuit_state` (0/1/2) en `GET /metrics`.
- **S3**: `POST /v1/files/presigned-upload|presign` y `GET /:id/download` envueltos en `s3Breaker`. Si OPEN → `503 DEPENDENCY_UNAVAILABLE`.

### Budgets

- `GET /v1/inventory` p95 HIT <50ms, MISS <300ms con 10k filas; `POST /v1/inventory/reserve` p95 <500ms.
- `bodyLimit 1MB` global, `256KB` en `auth/members/invite`.
- `GET /v1/branches` con 10k orgs no escala (sin paginación aún; pendiente cursor).

## Verificación rápida

```bash
# 1. Cache hit/miss + tenant isolation
COOKIE=$(curl -s -c - http://localhost:4000/v1/auth/dev-login -H 'content-type: application/json' -d '{"userId":"user-alice"}' | grep platform_session | awk '{print $7}')
curl -s -X POST http://localhost:4000/v1/auth/switch-organization -b "platform_session=$COOKIE" -H 'content-type: application/json' -d '{"slug":"acme"}' > /dev/null

curl -i http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | grep -i x-cache
# -> x-cache: MISS (primera), segunda -> HIT
curl -i http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | grep -i x-cache
# acme HIT no contamina contoso MISS
COOKIE2=$(curl -s -c - http://localhost:4000/v1/auth/dev-login -H 'content-type: application/json' -d '{"userId":"user-bob"}' | grep platform_session | awk '{print $7}')
curl -s -X POST http://localhost:4000/v1/auth/switch-organization -b "platform_session=$COOKIE2" -H 'content-type: application/json' -d '{"slug":"contoso"}' > /dev/null
curl -i http://localhost:4000/v1/branches -H 'host: contoso.app.localhost' -H "cookie: platform_session=$COOKIE2" | grep -i x-cache
# -> MISS (tenant key distinta)

# Invalidación: reserve invalida inventory
curl -s -X POST http://localhost:4000/v1/inventory/reserve -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" -H 'content-type: application/json' -d '{"branchId":"branch-acme-main","productId":"product-acme-1","quantity":1}' | jq
curl -i "http://localhost:4000/v1/inventory?branchId=branch-acme-main" -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | grep x-cache
# -> MISS (invalidada)

# 2. Rate limit per-IP (global)
for i in {1..101}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/v1/meta; done | sort | uniq -c
# 100×200, 1×429 con retry-after

# 3. Rate limit per-tenant isolation (hot tenant)
# Simular 1000 reqs acme (bypass: usar script k6 o bucle; aquí 20 órdenes limit)
for i in {1..21}; do curl -s -X POST http://localhost:4000/v1/orders -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" -H 'content-type: application/json' -d '{"branchId":"branch-acme-main","amountCents":1000}' -w "%{http_code} "| done; echo
# -> 20×201, 1×429
# contoso sigue 200
curl -s -X POST http://localhost:4000/v1/orders -H 'host: contoso.app.localhost' -H "cookie: platform_session=$COOKIE2" -H 'content-type: application/json' -d '{"branchId":"branch-contoso-main","amountCents":1000}' -w "%{http_code}\n"

# 4. Redis degradado (fail-open)
docker compose stop redis
curl -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | jq # sigue 200 con x-cache: MISS (fallback DB)
curl -s http://localhost:4000/health/ready | jq .status # degraded pero ok fallback
curl -s http://localhost:4000/metrics | grep cache_misses_total # sigue contando
docker compose start redis

# 5. S3 circuit breaker
# Forzar 5 fallos rápidos (si MinIO down)
docker compose stop minio
for i in {1..6}; do curl -s -X POST http://localhost:4000/v1/files/presigned-upload -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" -H 'content-type: application/json' -d '{"filename":"a.txt","contentType":"text/plain","size":100}' -w "%{http_code} "; done; echo
# -> primeros 5 → 500 o 503, 6º → 503 CIRCUIT_OPEN con circuit_state=2
curl -s http://localhost:4000/metrics | grep circuit_state
docker compose start minio
# esperar 30s para HALF_OPEN → CLOSED tras 2 éxitos
```

## Fallos y recuperación

| Señal                                 | Causa                                                        | Recuperación                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-cache: MISS` siempre               | Redis down / keys no hit                                     | Ver `docker compose logs redis`, `GET /metrics` `cache_misses_total` sube, `cache_hits 0`. API sigue 200 vía DB (p95 sube). Reiniciar `redis` no pierde datos.                          |
| `429 RATE_LIMITED` burst legítimo     | Cliente excede 100/min IP o 1000/min tenant                  | Respetar `retry-after`, usar backoff jitter. Si tenant legítimo necesita más, subir `RATE_LIMITS.tenant.max` y redeploy.                                                                |
| `hot tenant` monopoliza               | Un tenant 1000/min bloquea pero otros 200 OK                 | Alert `rate_limit_hits_total{key="rl:tenant:acme"}` >100/min → escalar worker `HPA` o `RATE_LIMITS.tenant` por tenant flag futuro.                                                      |
| `circuit_state=2` (OPEN)              | S3/OIDC 5 fallos 2s timeout                                  | `docker compose logs minio`, `curl minio:9000/minio/health/live`. Breaker pasa a `HALF_OPEN` tras 30s; si `GET /metrics` `circuit_rejects_total` sigue subiendo, revisar secret/access. |
| `cache_stampede_fallback_total` spike | Muchas VUs same hot key expirado (p.ej. k6 50 VUs inventory) | Aumentar TTL `inventory 30s → 60s` o `lockTtl 5s → 10s`, o precargar cache en worker relay. No es error, indica contención.                                                             |
| `x-cache: HIT` stale 30s              | Invalidación perdida (Redis down durante write)              | TTL acota a 30s; si crítico, `curl -X POST /invalidate?` futuro o bump `CACHE_VERSION v1→v2` y redeploy. Permisos nunca stale >30s.                                                     |

## Observabilidad

- `GET /metrics` → `cache_hits_total`, `cache_misses_total`, `cache_invalidations_total`, `cache_stampede_fallback_total`, `rate_limit_hits_total{key}`, `circuit_state{breaker}`.
- `GET /health/ready` → `redis:fail` si `REDIS_URL` ping timeout, status `degraded` pero no bloquea tráfico (fail-open).
- Logs pino: `cache miss {key, tenantHash}` (hash, no PII), `rate limited {key}` warn, `circuit open {breaker}` error.

## Estado actual (2026-09-01)

- InMemory per-instance: full coverage sin Docker. Redis: `SCAN` + `SET NX PX` con fallback. `cache.ts` + `rate-limit.ts` + `circuit-breaker.ts` con metrics.
- Tests `cache-rate-limit.test.ts` 8 PASS: key isolation, stampede 10 concurrent →1 loader, rate 5→429, tenant isolation, Redis degraded fail-open, circuit 5→OPEN.
- Evidencia `k6/inventory-stock1.js` stock 1 sigue 1×200 bajo rate limit tenant>30/min (ajustar `k6 --vus 10` si se limita).
- Pendiente: `testcontainers` Redis+MinIO efímero para `withRedis()` helper, y `k6` con `RATE_LIMIT_ENABLED=0` para benchmark puro cache p95.
