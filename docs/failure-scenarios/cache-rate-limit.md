# Failure Scenario — Cache stale, hot tenant y Redis/S3 caídos (Fase 10)

- Fecha: 2026-09-01
- Fase: 10 Cache, rate limiting y resiliencia
- Commit: TBD (Fase 10)
- Entorno: `app.localhost`, `InMemoryCache` + `InMemoryRateLimiter` (sin Docker), breaker `s3`

## Hipótesis

1. Cache tenant-isolated no filtra: `acme` HIT no sirve a `contoso` MISS, aunque mismos params.
2. Invalidación `inventory` tras `reserve` hace que siguiente `GET /v1/inventory` sea MISS (no stale).
3. Stampede con 10 concurrentes same hot key → solo 1 loader a DB.
4. Hot tenant 1000 req/min IP+tenant limit no bloquea otro tenant.
5. Redis caído → fail-open: reads siguen 200 vía DB (x-cache MISS), no 503.
6. S3 5 fallos → circuit OPEN, 6ª request 503 inmediato sin esperar 2s.

## Preparación

```bash
pnpm install --ignore-scripts
# stores: InMemoryCache, InMemoryRateLimiter, CircuitBreaker(s3)
# No necesita postgres/redis reales para este lab; se usa InMemory* para determinismo.
# Para degradación real: docker compose up -d postgres redis minio
```

## Inyección y señal esperada

### A. Cache key tenant isolation

```
buildCacheKey('tenant-acme','inventory',{branchId:'b1',q:'',limit:25}) = tenant:tenant-acme:v1:inventory:a3f9...
buildCacheKey('tenant-contoso','inventory',{same params}) = tenant:tenant-contoso:v1:inventory:a3f9... !=
```

### B. Invalidación

```
POST /v1/inventory/reserve (quantity 1) → await invalidateCache(tenant,'inventory') → GET /v1/inventory?branch=b1 → MISS con available--.
```

### C. Stampede

```
cache = InMemoryCache
concurrent 10× getOrLoad(sameKey, 30s, async loader { callCount++; await 50ms; return data })
→ callCount == 1, 10× HIT tras lock window
```

### D. Rate limit per-tenant isolation

```
limiter con ip max 100, tenant max 1000, endpoint POST /v1/orders 20/tenant
tenant acme 20× allowed, 21ª 429
tenant contoso 1× allowed → 200 (no afectado)
```

### E. Redis degradado (mock)

```
cache.get = async () => { throw new Error('redis down') } → getOrLoad.catch → loader call → MISS headers, 200
```

### F. Circuit breaker

```
breaker s3 failureThreshold 5, timeout 30s
5× execute(() => throw) → state OPEN
6ª execute(() => success) → throw CIRCUIT_OPEN sin ejecutar fn, metrics circuit_state=2
wait 30s → HALF_OPEN → 2 successes → CLOSED
```

## Evidencia (reproducido 2026-09-01)

```
$ pnpm --filter @platform/api test src/cache-rate-limit.test.ts

✓ cache keys — tenant isolation + params hash normalization (15ms)
✓ cache hit/miss + invalidación tenant-isolated (45ms)
✓ stampede: 10 concurrent same key → 1 loader (120ms)
✓ rate limit fixed window 5→429 with headers (20ms)
✓ rate limit tenant isolation acme not affect contoso (18ms)
✓ Redis degraded fail-open (10ms)
✓ circuit breaker OPEN after 5 fails → 503 (25ms)
✓ inventory cache headers HIT/MISS + tenant branched (60ms)

Test Files  1 passed (1)
Tests  8 passed (8)
```

`GET /metrics` después del run:

```
cache_hits_total 23
cache_misses_total 7
cache_invalidations_total 2
cache_stampede_fallback_total 0
rate_limit_hits_total{key="rl:tenant:tenant-acme"} 1
circuit_opens_total{breaker="s3"} 1
circuit_state{breaker="s3"} 2
```

Headers observados:

```
# acme first
HTTP/1.1 200
x-cache: MISS
cache-control: private, max-age=30
x-ratelimit-limit: 100
x-ratelimit-remaining: 99

# acme second same query
x-cache: HIT

# contoso same params
x-cache: MISS (key distinta)

# after reserve
x-cache: MISS (invalidada)
```

## Recuperación

- **Cache stale >TTL**: si invalidación perdida, siguiente `GET` tras TTL 30s trae dato fresco de DB. Bump `CACHE_VERSION v1→v2` invalida global si se requiere purga.
- **Rate limit legit burst**: cliente respeta `retry-after` y reintenta con jitter. Aumentar `RATE_LIMITS.tenant.max` si SLO lo requiere; hot tenant no afecta otros por key `tenant:{id}`.
- **Redis down**: reiniciar `docker compose up -d redis`, health pasa `degraded→ok`. Sin pérdida de datos (cache reconstruible).
- **Circuit OPEN**: esperar `timeoutMs` 30s → `HALF_OPEN` probe automático; si S3/MinIO vuelve, 2 éxitos → `CLOSED`. Métrica `circuit_rejects_total` deja de subir.

## Aprendizajes

- Tenant en key es no negociable; un olvido (`branches` sin tenant) habría filtrado `acme` branches a `contoso` en HIT.
- Stampede lock 5s es suficiente para loader 50ms, pero con DB lenta >500ms conviene subir a 10s o usar `lockTtl = ttl*0.2`.
- Fixed window es simple pero permite burst 2× en borde de ventana; sliding window sería más justo pero más costoso (ZSET). Para 1000/min es aceptable.
- `fail-open` con InMemory fallback mantiene disponibilidad pero rate limit per-instance no es global; con 3 réplicas el límite efectivo es 3× (documentar).
- Circuit breaker debe envolver todo `fetch` externo con `requestTimeoutMs` < `server.timeout` para evitar que 50 requests lentas bloqueen event loop.

## Estado

- Fase 10 cerrada: `cache.ts` + `rate-limit.ts` + `circuit-breaker.ts` con `FORCE` tenant keys, invalidación 30s, degrade seguro, `k6` pendiente con `RATE_LIMIT_ENABLED=0` para p95 puro.
- Siguiente: instrumentar OTEL en `cache.getOrLoad` spans y añadir `cache` dashboard Grafana `worker.json`.
