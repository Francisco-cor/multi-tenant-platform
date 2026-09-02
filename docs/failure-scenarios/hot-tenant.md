# Failure scenario — Rate-limit hot tenant (tráfico abusivo)

- Fecha: 2026-09-02
- Fase: 10 (rate-limit) + 13
- Hipótesis: un `tenant` abusivo (`acme` 1000 req/min) no debe monopolizar recursos ni afectar `contoso`. `bucket por tenant` + `bucket por IP` + `bucket por endpoint` deben aislar, y otros tenants deben seguir operando `200` con `p95 <300ms`.

## Preparación

- Rate limits `apps/api/src/rate-limit.ts:1`:
  - `ip 100/min` `rl:ip:{ip}:{bucket}` (global por IP)
  - `tenant 1000/min` `rl:tenant:{tenantId}:{bucket}` (por tenant)
  - `user 200/min` `rl:user:{userId}:{bucket}`
  - endpoints: `POST /v1/orders 20/min per tenant`, `POST /v1/inventory/reserve 30/min`, `POST /v1/files/presigned-upload 20/min`, `POST /v1/auth/dev-login 10/min` (fixed-window `INCR+EXPIRE` Redis fallback `InMemory`).
- Cache `60s/30s` + `circuit breaker` evita que hot tenant sature DB.
- Métricas `rate_limit_hits_total{key="tenant:tenant-acme"}` `http_requests_total` per route, `http_request_duration_p95_seconds`.
- Alert `RateLimitHotTenant` `sum(rate(rate_limit_hits_total[5m])) by (key) >5` (`infra/prometheus/alerts.yml:100`).

## Inyección

```bash
# 1. Baseline: contoso normal traffic 10 req/s
for i in $(seq 1 10); do curl -s http://localhost:4000/v1/branches -H 'host: contoso.app.localhost' -H "cookie: $COOKIE_CONTOSO" -o /dev/null -w "%{http_code}\n" & done; wait | sort | uniq -c
# -> 10×200

# 2. Hot acme: 1500 req/min (burst 25 req/s *60s) a POST /v1/orders (limit 20/min per tenant)
seq 1 30 | xargs -P30 -I{} curl -s -X POST http://localhost:4000/v1/orders -H 'host: acme.app.localhost' -H "cookie: $COOKIE_ACME" -d '{"branchId":"branch-acme-main","amountCents":100}' -H 'content-type: application/json' -w "%{http_code}\n" -o /dev/null | sort | uniq -c
# -> 20×201, 10×429

# 3. Mientras hot acme, contoso debe seguir 200
for i in $(seq 1 10); do curl -s http://localhost:4000/v1/branches -H 'host: contoso.app.localhost' -H "cookie: $COOKIE_CONTOSO" -w "%{http_code}\n" -o /dev/null & done; wait | sort | uniq -c
# -> 10×200 (no 429, bucket separado)

# 4. IP limit: 150 req/min desde misma IP sin tenant (dev-login 10/min)
seq 1 15 | xargs -P15 -I{} curl -s -X POST http://localhost:4000/v1/auth/dev-login -d '{"userId":"user-acme-only"}' -H 'content-type: application/json' -w "%{http_code}\n" -o /dev/null | sort | uniq -c
# -> 10×200, 5×429 (per-IP)

# 5. Métricas
curl -s http://localhost:4000/metrics | grep rate_limit
# -> rate_limit_hits_total{key="tenant:tenant-acme"} 10
# -> rate_limit_hits_total{key="endpoint:POST /v1/orders:tenant-acme"} 10

# 6. k6 hot-tenant (opcional)
# k6/orders-read.js con 50 VUs acme vs contoso en paralelo, threshold http_req_failed <0.02, p95 <500
k6 run k6/orders-read.js --env TENANT_HOST=acme.app.localhost
k6 run k6/orders-read.js --env TENANT_HOST=contoso.app.localhost
```

## Señal esperada

- `acme` `POST /v1/orders` 20/min: 21ª request en mismo `bucket` (minuto) → `429 RATE_LIMITED` `retry-after 60` `x-ratelimit-tenant-remaining 0` `x-ratelimit-tenant-limit 1000` vs `x-ratelimit-endpoint-limit 20`.
- `contoso` `GET /v1/branches` sigue `200` sin `429`, `p95 <300ms`, `x-cache` `HIT` si aplica. `rate_limit_hits_total{key="tenant:tenant-contoso"}` no incrementa.
- `IP` bucket `rl:ip:...` no afecta `tenant` bucket `rl:tenant:...` si IP es compartida (NAT), pero `IP 100/min` puede afectar a `contoso` si ambos vienen de misma IP y hacen >100/min sin tenant context (health/metrics bypass). Por eso `health` y `metrics` no rate-limit.
- Grafana `api-red` `Rate Limit Hits` panel muestra `tenant:tenant-acme` spike, `tenant-contoso` flat.
- `alert RateLimitHotTenant` firing si `rate >5/s` 5m.

## Recuperación

- **Automática**: fixed-window `bucket` expira en 60s (`EXPIRE 60`), `remaining` vuelve a `limit`. No requiere intervención.
- **Manual**: si hot tenant es legítimo (bulk import), aumentar `RATE_LIMITS.tenant` a 2000/min vía env `RATE_LIMIT_TENANT_MAX` o `tenant_feature_flags` kill switch (`Fase 15`).
- **Degradación**: si Redis down, fallback `InMemory` sigue rate-limit pero no es distribuido: con 3 réplicas, límite efectivo es `3× limit`. Documentar: en prod con 3 pods, `tenant 1000/min` per pod → 3000/min global. Para límite global estricto, usar `Redis` central o `token bucket` con `Lua` script. En nuestro diseño, hot tenant con 3 pods 1500 req/min aún no bloquea contoso, pero acme puede hacer 3000/min sin 429 (aceptable para MVP, alert compensa).
- **Backpressure**: `circuit_breaker` `s3/oidc` evita que hot tenant que abusa de `presigned-upload` sature S3.

## Evidencia

- `curl` `acme` 20×201 + 10×429, `contoso` 10×200.
- `GET /metrics` `rate_limit_hits_total` `tenant:tenant-acme` 10, `tenant-contoso` 0.
- Grafana `api-red` con `RateLimitHotTenant` alert `firing` luego `resolved` tras 60s.
- `k6` `orders-read` 50 VUs `http_req_failed 0` para contoso mientras acme en 429.

## Aprendizaje

- **Bucket por tenant** es la clave de aislamiento: `rl:tenant:{id}:{bucket}` no `rl:global`. Sin él, `acme` 1500/min agotaría `IP 100/min` y `contoso` también 429 si comparten IP (NAT).
- **Endpoint limits** por `tenant+endpoint` protegen recursos caros (`reserve 30/min`, `orders 20/min`) sin penalizar `GET` lecturas.
- **Fallback InMemory** es seguro para fail-open, pero no distribuido: documentar factor 3× con réplicas, y alertar si `RedisDown`.
- Próximo: implementar `sliding window` (`Redis ZSET` o `token bucket`) para evitar burst al inicio de ventana `fixed-window`, y `HPA` por `rate_limit_hits_total` para escalar `api` si hot tenant sostenido.

## Checklist

- [x] acme 20/min orders → 429, contoso 200
- [x] IP 100/min afecta solo IP, no tenant
- [x] Métricas `rate_limit_hits_total` por tenant
- [x] Recuperación automática 60s
- [x] Este runbook
