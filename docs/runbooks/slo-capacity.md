# Runbook — SLOs, error budgets y capacidad

- Owner: `platform-api` (SLOs de plataforma) con `platform-worker`, `platform-payments`, `platform-infra`
- Última revisión: 2026-11-13
- Cadencia: revisión mensual de SLOs; revisión de capacidad antes de cada campaña o cambio de tráfico
- Estado: objetivos de diseño para staging/producción pequeña; no hay medición histórica de producción todavía

## 1. SLIs y SLOs

Los objetivos son puntos de partida, no una promesa contractual. Se calibran con datos reales y se versionan aquí.

| Servicio             | SLI                                                                                      | SLO objetivo | Ventana  | Fuente                              |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------ | -------- | ----------------------------------- |
| API lectura          | Requests `GET` 2xx/3xx / totales, excluyendo 4xx de input                                | 99.9 %       | 30 días  | `http_requests_total`               |
| API latencia lectura | p95 de `GET /v1/branches`, `/v1/inventory`, `/v1/orders`                                 | < 300 ms     | 30 días  | `http_request_duration_p95_seconds` |
| API escritura        | p95 de `POST /v1/orders`, `/v1/inventory/reserve`, `/v1/files/presign` sin jobs externos | < 500 ms     | 30 días  | métricas HTTP                       |
| API errores          | 5xx / total, excluyendo input inválido                                                   | < 1 %        | 30 días  | `http_requests_total`               |
| Worker outbox        | Edad p95 de eventos `pending`                                                            | < 30 s       | 7 días   | `outbox_lag_seconds`                |
| Worker jobs          | Jobs completados sin DLQ / jobs elegibles                                                | > 99 %       | 7 días   | `job_duration`, `dlq_size`          |
| Webhooks             | Entregas `delivered` en <= 5 min / entregas elegibles                                    | > 99 %       | 7 días   | `webhook_deliveries`                |
| Webhooks DLQ         | Entregas `dead_letter` con edad > 24 h                                                   | 0            | continuo | `dlq_size` / tabla                  |
| Pagos                | Intentos `unknown` con edad > 30 min                                                     | 0            | continuo | `payment_unknown`                   |
| Pagos                | Doble cobro confirmado                                                                   | 0            | continuo | reconciliación + PSP                |
| Aislamiento          | Hallazgos cross-tenant confirmados                                                       | 0            | continuo | suite de seguridad/RLS              |

### Error budget

Para un SLO de 99.9 % en 30 días, el presupuesto es `0.001 × 43,200 min ≈ 43.2 min` de indisponibilidad equivalente. Para 99 % son `432 min`.

Política de consumo:

- **< 50 % consumido:** cambios normales.
- **50–75 %:** revisar tendencia; no aumentar riesgo sin justificación.
- **75–100 %:** congelar cambios no esenciales del servicio; priorizar fiabilidad.
- **> 100 %:** postmortem obligatorio y plan de recuperación antes de nuevas features del servicio.

El error budget no autoriza a ignorar incidentes de integridad: un solo leak cross-tenant o doble cobro es SEV1 aunque el budget esté sano.

## 2. Capacidad — supuestos iniciales

| Componente | Supuesto                                                          | Límite conocido                                                      |
| ---------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| API        | 1–2 instancias, pool DB `max:10` por instancia                    | El pool es por proceso; no hay aislamiento por tenant                |
| Rate limit | IP 100/min, tenant 1000/min, usuario 200/min, endpoints 20–30/min | Fixed window; un burst puede duplicar la tasa media                  |
| Worker     | `concurrency 10` por cola, handler timeout 10 s                   | Un job lento reduce throughput; leases evitan bloqueo permanente     |
| PostgreSQL | Réplica única local; producción gestionada                        | Sin réplicas de lectura ni particionado                              |
| Redis      | Una instancia; cache reconstruible y colas                        | Si cae, cache/rate limit degradan y las colas requieren recuperación |
| S3/MinIO   | Un bucket; presigned 300 s/60 s                                   | Sin CDN; el cliente habla directo                                    |
| Webhooks   | Reintentos 8, backoff 10 s→10 m                                   | Un receptor lento consume workers de la cola                         |

Fórmulas útiles:

- Capacidad de API ≈ `instancias × (1000 / p95_seconds) × utilización_objetivo`.
- Capacidad de worker ≈ `concurrency / duración_media_job`.
- Si el p95 de un handler se acerca al timeout (10 s), el throughput efectivo cae aunque haya workers libres.
- Con rate limit por tenant, un tenant no puede consumir más de 1000 req/min aunque haya capacidad global.

## 3. Carga y pruebas

Referencias en `k6/`:

- `k6/orders-read.js`: lectura de órdenes con stages 20→50 VUs; objetivo p95 < 300 ms.
- `k6/soak.js`: 10 VUs durante 5 min, mezcla lectura/reserva; busca fugas y degradación.
- `k6/hot-tenant.js`: un tenant agresivo y otro normal; valida aislamiento de rate limit.
- `k6/inventory-stock1.js`: 50 VUs con stock 1; 1×201 y 49×409.

Estado: los scripts **no** se ejecutan en CI. Los resultados deben registrarse con fecha, commit, entorno y configuración (`RATE_LIMIT_ENABLED`, VUs, duración). No se debe citar un p95 histórico como si fuera producción.

## 4. Capacidad y saturación — señales

| Señal           | Umbral de atención         | Acción                                                 |
| --------------- | -------------------------- | ------------------------------------------------------ |
| p95 API lectura | > 300 ms durante 5 min     | Revisar cache, pool, DB, query plan                    |
| 5xx             | > 1 % durante 5 min        | Ver `docs/runbooks/observability.md`                   |
| Pool DB         | conexiones activas ≈ `max` | Reducir concurrencia, revisar transacciones largas     |
| Outbox lag      | > 30 s                     | Revisar worker/relay/Redis; ver `dlq-replay.md`        |
| DLQ             | > 0 nuevo                  | Inspeccionar, corregir y replay                        |
| Redis           | `up == 0`                  | Fail-open de cache; rate limiter local; ver `cache.md` |
| Disco           | < 15 % libre               | Alert `DiskSpaceLow`; ampliar o purgar retención       |
| Webhook DLQ     | edad > 24 h                | Revisar receptor, secretos y egress                    |

## 5. Revisión mensual

- [ ] Comparar SLOs con datos de Prometheus; documentar desviaciones.
- [ ] Revisar error budget y decisiones de congelación.
- [ ] Revisar p95/p99 por endpoint y tenant.
- [ ] Revisar crecimiento de outbox, DLQ, audit y archivos.
- [ ] Revisar capacidad de DB/Redis/S3 y costos.
- [ ] Actualizar este documento con fecha y owner.

## 6. Referencias

- `infra/prometheus/alerts.yml` — alertas y owners.
- `docs/runbooks/observability.md` — diagnóstico.
- `docs/runbooks/incident-response.md` — severidades y escalado.
- `docs/runbooks/dlq-replay.md` — outbox/DLQ.
- `docs/failure-scenarios/hot-tenant.md`, `db-slow.md`, `redis-down.md`.
