# ADR-010: Cache, rate limiting y resiliencia (Fase 10)

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: Fase 10 (IMPLEMENTATION_PLAN.md:405, PLAN_ELEVACION.md:350), `apps/api/src/cache.ts`, `apps/api/src/rate-limit.ts`, `apps/api/src/circuit-breaker.ts`, `packages/observability/src/metrics.ts`

## Contexto

Añadir rendimiento sin convertir Redis en segunda fuente de verdad. Riesgos:

1. **Sin cache tenant-scoped**: respuestas viejas por TTL largo o keys globales filtran datos entre tenants.
2. **Sin rate limit por tenant**: hot tenant monopoliza DB, pool y workers; otros tenants sufren latencia 5xx.
3. **Sin fail-open**: Redis caído marca API `degraded` pero debería seguir sirviendo con DB (fuente de verdad).
4. **Sin circuit breaker**: proveedor externo (S3, OIDC) lento hace cascada; cada request espera 30s y satura event loop.
5. **Stampede**: expiración simultánea de key popular (p.ej. `GET /v1/inventory?branch=main`) genera cientos de queries idénticas.

Opciones:

1. No cache / no rate limit (simple pero no escala, hot tenant DoS).
2. Cache en Redis con keys `tenant:v1:resource:hash`, TTL acotado, invalidación por evento/outbox, stampede lock `SET NX`, rate limit fixed-window por IP/tenant/endpoint + circuit breaker con timeout 2s.
3. Cache en memoria por instancia sin tenant (rápido pero filtra, difícil invalidar global).

Elegir (2). Redis sigue siendo reconstruible; DB permanece autoridad.

## Decisión

### 1. Lecturas cacheables y TTL

| Recurso | Endpoint | TTL | Justificación |
|---------|----------|-----|---------------|
| branches | `GET /v1/branches` | 60s | lista corta, cambia selten (create org/branch) |
| members | `GET /v1/members` | 30s | RBAC sensible pero reconstruible; invalidación inmediata en `invitation/patch/delete` |
| inventory | `GET /v1/inventory?branch=&q=&limit=&cursor=` | 30s | catálogo por sucursal, lectura costosa (`JOIN products` + `ILIKE`), invalidación en `POST /v1/inventory/reserve` |
| webhooks endpoints | `GET /v1/webhooks/endpoints` | 60s | config estable, invalidación en `POST/PATCH/DELETE` |
| No cache | `GET /v1/orders*`, `GET /v1/files*`, `POST *` | — | estado transaccional o ya con validación de stock/pago; no se cachea |

TTL máximo 60s por recurso. Toda cache es `private` (`cache-control: private, max-age=...`) + `x-cache: HIT|MISS`.
Nunca cachear permisos crudos sin tenant.

### 2. Keys con tenant, versión y params normalizados

```
cacheKey = `tenant:{tenantId}:{VERSION}:{resource}:{hash16}`
VERSION = v1 (permite invalidar global al subir versión)
hash16 = sha256(JSON.stringify(sorted(params))).slice(0,16)
Ej: tenant:tenant-acme:v1:inventory:branch=main:hash=a3f9c1e2...
```

- `tenantId` **obligatorio**; ningún key global. Test: `cacheKeyFor acme != contoso` aunque mismos params.
- Orden de params no afecta (keys sorted). `q=widget&limit=25` == `limit=25&q=widget`.
- Prefijo para invalidación: `tenant:{id}:v1:{resource}:*` → `deleteByPrefix` via `SCAN MATCH`.

### 3. Invalidación por evento/outbox

- Escritura confirmada → `await cache.deleteByPrefix(prefix)` inmediatamente después de `store` + `audit`. Ejemplo: `reserve` → `invalidateCache(tenantId,'inventory')`.
- Outbox futuro puede reemitir `inventory.reserved` → worker podría invalidar réplicas; hoy es directo porque API es quien escribe.
- No se usa `writeOutboxEvent` para cache (sería dual write); invalidación es best-effort y TTL acota staleness a 30s si se pierde evento.
- Documentado en `docs/runbooks/cache.md`: si invalidación falla (Redis down), TTL asegura no stale >60s; ningún permiso se cachea >30s.

### 4. Cache-aside con stampede protection

```ts
const {value, hit} = await cache.getOrLoad(key, ttl, loader, {lockTtlMs: 5000})
```

- **HIT**: retorna cached sin DB.
- **MISS**: intenta `SET lockKey NX PX 5s`. Si gana lock → ejecuta `loader()` (DB), `SET key PX ttl`, libera lock. Si pierde lock → poll 10×50ms por `GET key` (espera al ganador). Si sigue miss → ejecuta loader de todos modos (degradado) y cuenta `cache_stampede_fallback_total`.
- Redis: `SET key PX` y `SET lock NX PX` atomics. InMemory: `Map lock` + `setTimeout`.
- Métricas: `cache_hits_total`, `cache_misses_total`, `cache_invalidations_total`, `cache_stampede_fallback_total`.

### 5. Rate limits por IP / tenant / usuario / endpoint sensible

```ts
RATE_LIMITS = {
  ip: {max:100, windowMs:60_000},       // global per-IP (abuso)
  tenant: {max:1000, windowMs:60_000},  // hot tenant isolation
  user: {max:200, windowMs:60_000},
  endpoints: {
    'POST /v1/orders': {max:20, key:'tenant'},
    'POST /v1/inventory/reserve': {max:30, key:'tenant'},
    'POST /v1/files/presigned-upload': {max:20, key:'tenant'},
    'POST /v1/webhooks/endpoints': {max:20, key:'tenant'},
    'POST /v1/auth/dev-login': {max:10, key:'ip'},
  }
}
```

- Implementación: `RateLimiter` con `RateLimitStore` (`Redis incr+expire` o `InMemory Map`). Key = `rl:{kind}:{identifier}:{bucket}` donde `bucket = floor(now/windowMs)`. Fixed window.
- **Tenant-scoped**: `tenant:{id}` evita que `acme` consuma 1000 req y bloquee `contoso`; test `hot-tenant` verifica `contoso` sigue 200 tras `acme` 1000×.
- **Headers**: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after` en 429. `429 {code:RATE_LIMITED, details:{retryAfter}}`.
- **Fail behavior**: si Redis falla → fallback a InMemory per-instance (sigue limitando localmente, evita 5xx por Redis). Nunca `fail-closed` total; global `RateLimiter` captura excepción y usa fallback. Para `POST /auth/dev-login` aun sin Redis, instancia local limita a 10/min por IP (seguro).

### 6. Redis degradado

- **Cache**: `get`/`set` capturan excepción y retornan `miss`/`void`. Lectura cae a DB (p95 sube de 50ms a 250ms pero correcto). `GET /health/ready` reporta `redis:fail` → `degraded` (observabilidad) pero liveness `ok`.
- **Rate limit**: fallback InMemory como arriba.
- **No hay cache de permisos**: si Redis down no se expone permiso viejo.

### 7. Timeouts, circuit breakers y budgets

| Proveedor | Breaker | `failureThreshold` | `timeoutMs` | `requestTimeoutMs` | Efecto OPEN |
|-----------|---------|-------------------|-------------|-------------------|-------------|
| s3 presigned | `s3` | 5 | 30s | 2s | `503 DEPENDENCY_UNAVAILABLE` sin bloquear worker; métrica `circuit_state{breaker="s3"}`=2 |
| payment provider (worker) | `payment` | 5 | 30s | 3s | ya existente `payment_unknown` + breaker |
| oidc discover | `oidc` | 3 | 60s | 2s | `503` en `/v1/auth/login|callback` |

- Breaker estados `CLOSED → OPEN (fail fast) → HALF_OPEN (probe) → CLOSED`. Métricas `circuit_opens_total`, `circuit_rejects_total`, `circuit_state` (0/1/2) en `/metrics`.
- Timeouts: todo `fetch`/S3 envuelto en `withTimeout(..., requestTimeoutMs)`; evita que un pool saturado cause cascada.
- **Budgets**: `GET /v1/inventory` p95 <300ms (sin cache), <50ms HIT; `POST /v1/inventory/reserve` p95 <500ms sin jobs externos; payload `bodyLimit 1MB` global, `256KB` rutas `auth|members`. Documentado en `docs/runbooks/cache.md` y verificado con `k6` (Fase 5).

### Consecuencias

- **Pros:** aislamiento hot tenant probado, latencia reads HIT 5× menor, degrade seguro sin Redis, S3 lento no tumba API, stampede controlado.
- **Contras:** doble RTT en miss+lock, eventual staleness 30s (aceptable para inventario branch/lista), `SCAN` en `deleteByPrefix` costoso si muchas keys (mitigado por TTL corto + prefix tenant).
- **Alternativa descartada:** cache permisos por usuario sin tenant habría permitido `userA` ver `contoso` members tras switch (rechazado).

## Validación

- `apps/api/src/cache-rate-limit.test.ts:1` 8 tests: key tenant isolation + params hash normalization, cache hit→miss tenant A≠B, invalidation solo tenant, stampede 10 concurrent → 1 loader, rate limit 5→429 con headers, tenant isolation `acme` limit not affect `contoso`, Redis degraded fail-open (mock `get` throw → loader), circuit OPEN after 5 fails → `CIRCUIT_OPEN`.
- `apps/api/src/app.test.ts` + `inventory.test.ts` siguen 26 PASS con headers `x-cache`/`x-ratelimit-*` opcionales.
- `worker` no cambia; `health.ts` `checkRedis` sigue `degraded` si Redis fail pero API sigue 200 en reads via fallback.
- `openapi.yaml` 37 paths 47 schemas `hash ee...` actualizado (`429` + `x-ratelimit` headers documentados).
- Métricas `cache_hits_total`, `rate_limit_hits_total`, `circuit_state` visibles en `GET /metrics` y dashboard `infra/grafana/worker.json`.

## Referencias

- `apps/api/src/cache.ts:1` `buildCacheKey`/`getOrLoad`/`deleteByPrefix`,
- `apps/api/src/rate-limit.ts:1` `createRateLimiter`/`RATE_LIMITS`,
- `apps/api/src/circuit-breaker.ts:1` `CircuitBreaker`,
- `apps/api/src/app.ts` `enforce*RateLimit` + `invalidateCache` + `s3Breaker`,
- `packages/observability/src/metrics.ts` `recordCacheHit` etc.,
- `docs/runbooks/cache.md` + `docs/failure-scenarios/cache-rate-limit.md`.
