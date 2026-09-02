# Failure scenario — Redis caído (degradación segura)

- Fecha: 2026-09-02
- Fase: 10 (cache/rate-limit) + 13
- Hipótesis: con `Redis` detenido, la API sigue sirviendo tráfico tenant-scoped usando DB como fuente de verdad. `GET /v1/branches` y `GET /v1/inventory` deben fallar-open a `MISS` (no 500), `rate limiting` debe usar fallback `InMemory`, `health` debe marcar `redis` fail pero `degraded` no `fail` (liveness sigue ok). Ninguna escritura debe depender de Redis.

## Preparación

- Stack: `docker compose up -d postgres redis` + `pnpm dev` (api:4000 worker).
- Datos: 2 tenants `acme`/`contoso` con branches/inventory seed. `CACHE_TTLS branches 60s/inventory 30s` (`apps/api/src/cache.ts:1`), `RATE_LIMITS ip 100/tenant 1000/user 200` (`rate-limit.ts:1`), `createInMemoryCache` + `createInMemoryRateLimiter` fallback (`cache.ts:10`, `rate-limit.ts:1`).
- Métricas: `cache_misses_total`, `cache_hits_total`, `rate_limit_hits_total`, `circuit_state{breaker="s3"}`, `GET /metrics` scrape 10s.
- Health: `apps/api/src/health.ts:56` `checkRedis` `ping` timeout 2s, `getReadiness` → `degraded` si `redis` fail, `skip` si `REDIS_URL` no set.

## Inyección

```bash
# 1. Baseline con Redis up
curl -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> x-cache: MISS (primera) luego HIT

docker compose stop redis
# o: docker compose kill redis

# 2. Requests con Redis down
for i in 1 2 3; do curl -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep -E 'x-cache|200'; done
# -> 200, x-cache: MISS (siempre, fail-open)
# -> No 500, no 429 inesperado (rate limiter fallback InMemory)

# 3. Rate limit aún funciona (InMemory)
for i in $(seq 1 105); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/v1/auth/dev-login -X POST -d '{"userId":"user-acme-only"}' -H 'content-type: application/json' | tail -1; done | sort | uniq -c
# -> 100× 200, 5× 429 (per-IP 100/min sigue con InMemory)

# 4. Health
curl -s http://localhost:4000/health/ready | jq
# -> {"status":"degraded","dependencies":[{"name":"postgres","status":"ok"},{"name":"redis","status":"fail","error":"...timeout..."},{"name":"outbox","status":"ok"}]}
curl -s http://localhost:4000/health/live | jq
# -> {"status":"ok"} (liveness no depende de Redis opcional)

# 5. Métricas
curl -s http://localhost:4000/metrics | grep redis
# -> (no redis metric, pero cache_misses_total incrementa)

# 6. Recuperación
docker compose start redis
sleep 5
curl -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> MISS luego HIT (cache vuelve a funcionar, invalidations no perdidas porque TTL 60s)
```

## Señal esperada

- Con Redis down: `GET /v1/branches` 200 `MISS` siempre (no `HIT`), latencia <50ms extra (DB fallback). `GET /v1/inventory` igual. `POST /v1/inventory/reserve` 201 (no usa Redis, usa `UPDATE ... WHERE available>=`).
- `rateLimit` no bloquea tráfico normal: 429 solo tras 100 req/min IP (InMemory fallback funciona).
- `health/ready` `degraded` (no `ok`), `health/live` `ok`. `GET /metrics` `cache_misses_total` ↑, `cache_hits_total` no ↑.
- Logs: `cache.get miss fallback Redis down` no deve loggear stack trace, solo `warn` con `tenantHash`.
- Grafana `DB / Redis / Infra` dashboard (`db-redis.json`) muestra `up{job="redis"}==0` y `RedisDown` alert firing.

## Recuperación

- `docker compose start redis` → `checkRedis` vuelve `ok` en <5s, `health/ready` pasa a `ok`, `cache` vuelve a `HIT` tras TTL.
- No se requiere invalidación manual: `cache.deleteByPrefix` es `SCAN` sobre Redis, pero con Redis down las invalidations se pierden; el TTL acotado (60s branches, 30s inventory) garantiza que datos viejos no sobreviven >TTL. Para permisos, nunca cachear `audit:read`, solo `branches/members/inventory` reconstruibles.
- `worker` queues: `InMemoryQueue` dedupe sigue funcionando; `BullMQ` no usado en dev, pero en prod `BullMQ` requiere Redis: si Redis down, `relay` `publish` falla, `outbox_events` queda `pending` y `lag` ↑ → alerta `OutboxLag`, pero no se pierde evento (transactional outbox).

## Evidencia

- `curl /health/ready` con Redis stop: `degraded` + `redis fail`.
- `curl /metrics` antes/después: `cache_hits_total` no incrementa durante down, `cache_misses_total` +3.
- `k6` con Redis down: `http_req_failed <2%`, `p95 <500ms` (DB fallback no degrada p95 >300ms gracias a índice `stock_per_branch`).
- Captura Grafana `db-redis` con `RedisDown` firing y luego resolved.

## Aprendizaje

- Redis es **cache reconstruible**, nunca fuente de verdad. `createInMemoryCache` y `createInMemoryRateLimiter` son fallbacks válidos, no `throw`.
- `health` separa `liveness` (proceso vivo) de `readiness` (deps). Redis es opcional → `degraded` no `fail`, evita que orchestrator mate pods sanos.
- `CIRCUIT_BREAKER` para `s3/oidc/payment` evita cascada si Redis down afecta también `BullMQ`; `withTimeout 2s` + `503` es seguro.
- Próximo: añadir `redis` `replica` + `sentinel` en prod `infra/terraform`, y `alert` `RedisDown` con `severity critical` si `up==0` >2m.

## Checklist

- [x] `GET /v1/branches` fail-open `MISS` 200, no 500
- [x] `rate limiting` fallback InMemory 100/min IP
- [x] `health/ready degraded` + `health/live ok`
- [x] `cache_misses_total` ↑, `cache_hits_total` no ↑ durante down
- [x] Recuperación `HIT` tras `docker start redis` <5s
- [x] Este runbook con evidencia
