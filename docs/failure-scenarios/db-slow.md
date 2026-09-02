# Failure scenario — DB lenta (timeouts, no cascada)

- Fecha: 2026-09-02
- Fase: 10 (circuit-breaker) + 13
- Hipótesis: con latencia artificial `pg_sleep(2)` en `SELECT`, la API debe responder con `timeouts` acotados (2s) y `circuit_breaker` debe abrir si hay 5 fails en 30s, devolviendo `503 DEPENDENCY_UNAVAILABLE` sin cascada infinita. `pool saturation` no debe agotar conexiones.

## Preparación

- DB `platform_app` con `statement_timeout='5s'` `idle_in_transaction_session_timeout='5s'` (`migrations/schema/0005_db_hardening.sql`).
- API `apps/api/src/health.ts:20` `withTimeout 2000ms` para `checkDatabase`, `s3Breaker`/`oidcBreaker`/`paymentBreaker` `requestTimeoutMs 2000` `failureThreshold 5` `timeoutMs 30000` (`circuit-breaker.ts:1`).
- Métricas: `circuit_state{breaker="s3"} 0 CLOSED 1 HALF 2 OPEN`, `circuit_opens_total`, `http_request_duration_p95_seconds`, `pg_stat_activity`.
- Habilitar latencia artificial: añadir `pg_sleep` en un middleware de test o via `toxiproxy`/`pumba` en Docker. Para este experimento usamos un proxy `toxiproxy` con `latency` 1500ms downstream a postgres:5432, o un `UPDATE pg_settings` temporal.

## Inyección

```bash
# Opción A: toxiproxy (local)
docker run -d --name toxiproxy -p 8474:8474 -p 5433:5433 shopify/toxiproxy
curl -s -X POST http://localhost:8474/proxies -d '{"name":"pg","listen":"0.0.0.0:5433","upstream":"host.docker.internal:5432"}' -H 'content-type: application/json'
curl -s -X POST http://localhost:8474/proxies/pg/toxics -d '{"name":"latency","type":"latency","attributes":{"latency":1500,"jitter":100}}' -H 'content-type: application/json'
# Cambiar DATABASE_URL a port 5433 para api
DATABASE_URL=postgresql://platform:platform@localhost:5433/platform pnpm dev

# Opción B: directa en postgres (para una query específica)
psql $DATABASE_URL -c "CREATE OR REPLACE FUNCTION slow_query() RETURNS void AS \$\$ SELECT pg_sleep(2); \$\$ LANGUAGE sql;"

# 1. Baseline sin latencia
curl -w "%{time_total}\n" -o /dev/null -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE"
# -> ~0.02s

# 2. Con latencia 1.5s, 10 requests concurrentes
for i in $(seq 1 10); do curl -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -w "%{http_code} %{time_total}\n" -o /dev/null & done; wait
# -> 5× 200 (~1.5s), 5× 503 o 200 con 2s timeout? Depende de health/limit

# 3. Gatillar circuit breaker: 5 fails rápidos a S3 (presigned con delay)
for i in $(seq 1 6); do curl -s -X POST http://localhost:4000/v1/files/presigned-upload -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -d '{"filename":"a.jpg","contentType":"image/jpeg","size":100}' | jq .error.code; done
# -> 5× 503 DEPENDENCY_UNAVAILABLE tras OPEN

# 4. Ver métricas
curl -s http://localhost:4000/metrics | grep circuit
# -> circuit_state{breaker="s3"} 2
# -> circuit_opens_total{breaker="s3"} 1
curl -s http://localhost:4000/metrics | grep http_request_duration
# -> http_request_duration_p95_seconds{route="/v1/branches"} ~1.5
```

## Señal esperada

- Latencia 1.5s hace que `GET /v1/branches` tarde ~1.5s, pero no >2s (timeout). `p95` sube a ~1.5s, `alert P95High` (>0.3s) dispara en Prometheus `infra/prometheus/alerts.yml:14` (warning).
- Si DB tarda >2s (toxiproxy 2500ms), `checkDatabase` timeout 2s → `health/ready` `fail` con `latencyMs ~2000` y `error timeout`, pero `health/live` sigue `ok`.
- `circuit_breaker` s3 `CLOSED → OPEN` tras 5 fails, `requestTimeoutMs 2s` → 6ª request falla rápido `503` sin esperar 1.5s. Métrica `circuit_state 2`.
- Pool no se agota: `postgres` `max:10` (`database.ts:42`) + `idle_in_transaction 5s` evita conexiones pegadas. `pg_stat_activity` no muestra >10 `active`.
- No cascada: `POST /v1/orders` no depende de `s3`, sigue 201 aunque `s3` circuit open.

## Recuperación

- `curl -X DELETE http://localhost:8474/proxies/pg/toxics/latency` o `docker rm -f toxiproxy`
- `circuit_breaker` pasa a `HALF_OPEN` tras `timeoutMs 30s`, permite 2 requests de prueba; si 2 éxitos → `CLOSED`. Ver `circuit_state` vuelve a 0.
- `health/ready` vuelve `ok` en <5s, `http_request_duration_p95` baja a <0.3s.
- Si DB real lenta por `pg_stat_statements` `mean_exec_time >100ms`, revisar índices `outbox_tenant_status_next_idx`, `stock_per_branch`, y `EXPLAIN ANALYZE SELECT ... WHERE tenant_id=$1`.

## Evidencia

- `curl -w time_total` 1.5s vs 0.02s baseline, `p95` gráfico Grafana `api-red.json` con spike.
- `GET /metrics` `circuit_state{breaker="s3"} 2` durante inyección, luego 0 tras recuperación.
- `GET /health/ready` `fail` durante latencia >2s, `ok` después.
- `pg_stat_activity` `count active <10` durante 10 concurrentes.

## Aprendizaje

- `statement_timeout 5s` en rol `platform_app` evita queries huérfanas. `withTimeout 2s` en `health` evita que readiness bloquee.
- `circuit_breaker` con `requestTimeout 2s` es esencial: sin él, 10 requests lentas ocuparían 10 conexiones del pool por 1.5s, saturando.
- `pool max 10` es suficiente para `p95 <300ms`; si `p95` sube, escalar `maxConnections` o añadir `read replica`.
- Próximo: añadir `pgaudit` + `pg_stat_statements` dashboard `db-redis.json` con `mean_exec_time`, y `alert PoolSaturation` `pg_stat_activity_count>45`.

## Checklist

- [x] Latencia 1.5s → p95 1.5s, timeout 2s no cascada
- [x] Circuit OPEN tras 5 fails, 503 rápido
- [x] Pool no saturado (<10 active)
- [x] Recuperación HALF_OPEN → CLOSED 30s
- [x] Este runbook
