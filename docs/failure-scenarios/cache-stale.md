# Failure scenario — Cache stale (invalidación omitida)

- Fecha: 2026-09-02
- Fase: 10 (cache) + 13
- Hipótesis: si una escritura no invalida cache (ej. `POST /v1/inventory/reserve` no llama `deleteByPrefix`), el `GET /v1/inventory` debe devolver datos viejos solo hasta `TTL` (30s inventory, 60s branches/webhooks) y no debe cachear permisos. La invalidación vía `outbox` event es eventual, pero `getOrLoad` con `lock SET NX PX 5s` evita stampede.

## Preparación

- Cache `apps/api/src/cache.ts:1` `buildCacheKey tenant:{id}:v1:{resource}:hash16` `TTL branches 60s/inventory 30s/webhooks 60s` `getOrLoad` lock `SET NX PX 5s` poll 10×50ms + `deleteByPrefix SCAN`.
- Escrituras: `POST /v1/inventory/reserve` `POST /v1/branches` `POST /v1/webhooks/endpoints` llaman `invalidateCache(tenantId, resource)` (`app.ts:763` `deleteByPrefix`).
- Permisos nunca cacheados: `requirePermission` lee `membership.role` de DB cada request, no de cache.
- Métricas: `cache_hits_total`, `cache_misses_total`, `cache_invalidations_total`, `cache_stampede_fallback_total`, `x-cache HIT|MISS`.
- Test `apps/api/src/cache-rate-limit.test.ts:26` verifica `HIT/MISS` y `tenant isolation`.

## Inyección — omitir invalidación

```bash
# 1. Baseline con invalidación correcta
curl -s http://localhost:4000/v1/inventory?branchId=branch-acme-main -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> MISS (primera)

curl -s http://localhost:4000/v1/inventory?branchId=branch-acme-main -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> HIT (segunda, TTL 30s)

curl -s -X POST http://localhost:4000/v1/inventory/reserve -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -d '{"branchId":"branch-acme-main","productId":"product-acme-1","quantity":1}' | jq
# -> 201 reserve, available 1→0, invalida cache inventory

curl -s http://localhost:4000/v1/inventory?branchId=branch-acme-main -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> MISS (invalidada correctamente), body available 0

# 2. Simular bug: comentar invalidateCache en POST /v1/inventory/reserve (apps/api/src/app.ts:1278)
# Rebuild: pnpm --filter @platform/api build && docker build -f apps/api/Dockerfile -t test:local .
# O inyectar en test: mock cache.deleteByPrefix to no-op

# 3. Con bug, repetir:
curl -s http://localhost:4000/v1/inventory?branchId=branch-acme-main -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> MISS (primera)
curl -s -X POST http://localhost:4000/v1/inventory/reserve ... (con bug, no invalida)
curl -s http://localhost:4000/v1/inventory?branchId=branch-acme-main -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> HIT (stale!) body still available 1 (viejo), no 0

sleep 31
curl -s http://localhost:4000/v1/inventory?branchId=branch-acme-main -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -i | grep x-cache
# -> MISS (TTL expiró), body ahora available 0 (correcto tras 30s)

# 4. Verificar que permisos no son cacheados stale: cambiar role operator→manager y probar
curl -s -X PATCH http://localhost:4000/v1/members/<id> -H 'host: acme.app.localhost' -H "cookie: $COOKIE_OWNER" -d '{"role":"manager"}' | jq
curl -s http://localhost:4000/v1/members -H 'host: acme.app.localhost' -H "cookie: $COOKIE_OP" | jq
# -> Si cacheara permisos, operator seguiría viendo 403; pero no cachea, ve 200 correcto (permission check lee DB)

# 5. Stampede: 50 VUs mismo GET expirado (k6)
k6 run k6/inventory-stock1.js --vus 50 --iterations 50
# -> Con lock SET NX PX 5s, solo 1 debe ir a DB, 49 esperan poll 10×50ms y luego HIT (cache_stampede_fallback_total no debe explotar)
```

## Señal esperada

- Con invalidación correcta: `POST reserve` → `GET` siguiente `MISS` y `available` actualizado. `cache_invalidations_total` ↑.
- Con bug (invalidación omitida): `GET` siguiente `HIT` stale `available 1` hasta `TTL 30s`, luego `MISS` corrige. `P95` no debe superar `300ms` aunque stale, porque `TTL` acota ventana.
- Permisos nunca stale: `role` change es inmediato, no `HIT` de cache de permisos (no existe cache de `membership.role`).
- `x-cache` header siempre `HIT|MISS`, no `STALE`. `cache-control: private, max-age=30`.
- Métricas `cache_stampede_fallback_total` debe ser 0 en hot key expirado con lock, no 50.

## Recuperación

- **TTL acotado** es la recuperación automática: `branches 60s`, `inventory 30s`, `webhooks 60s`. No necesita manual.
- **Invalidation** es la recuperación rápida: `deleteByPrefix` `SCAN` + `DEL` por `tenant:{id}:v1:inventory:*`. Si falla (Redis down), es fail-open: `Misses` ↑ pero datos siguen en DB, y TTL corrige.
- Si bug de invalidación se detecta en prod, deploy fix + `FLUSHDB` por `tenant:{id}:*` o esperar TTL. No se requiere `kill switch` porque no hay inconsistencia permanente.
- **No cachear permisos**: `rolesHavePermission` siempre lee `membership.role` de `store` (DB/InMemory), nunca de `cache`. Si se añadiera cache de permisos, TTL debe ser 0 o 5s y `invalidateCache` en `PATCH /members/:id`.

## Evidencia

- `curl -i` `x-cache` `MISS→HIT→MISS` con invalidación, `HIT stale` sin invalidación + `MISS` tras 31s.
- `GET /metrics` `cache_invalidations_total` incrementa tras `POST reserve` (con fix).
- Grafana `api-red.json` `Cache HIT/MISS` panel muestra `HIT` 100% durante bug, luego `MISS` tras TTL.
- `cache-rate-limit.test.ts` `GET /v1/inventory` `HIT/MISS` test pasa con invalidación, falla si se comenta `invalidateCache` (demostrable).

## Aprendizaje

- **Cache key**: `tenant:{id}:v1:{resource}:hash16` evita `global` key leak; `deleteByPrefix` es `O(N)` `SCAN`, no `KEYS`. Para 10k keys tenant, `SCAN 100` es suficiente.
- **Stampede lock**: `SET NX PX 5s` + `poll 10×50ms` evita que 50 VUs golpeen DB a la vez. Sin lock, `stock 1` 50 concurrentes haría 50 `SELECT` y `UPDATE`.
- **Permisos**: nunca cachear `audit:read` o `members:invite`; solo datos reconstruibles (`branches`, `inventory`, `webhooks`).
- Próximo: añadir `cache` `version` `v1→v2` en `buildCacheKey` para invalidar global tras deploy de `schema`, y `alert` `CacheStampedeFallbackHigh` si `rate>0.5/s`.

## Checklist

- [x] Invalidación correcta → MISS inmediato, stale solo TTL
- [x] Permisos no cacheados
- [x] Stampede lock funciona 50 VUs → 1 DB hit
- [x] Este runbook
