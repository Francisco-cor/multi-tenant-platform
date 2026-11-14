# Demo para entrevista — 15 minutos

- Última revisión: 2026-11-13
- Objetivo: demostrar aislamiento, consistencia bajo fallo y evidencia operativa, no cantidad de pantallas
- Regla: no afirmar nada que no se pueda ejecutar en la sesión

## 1. Preparación (2 min)

```bash
pnpm install --ignore-scripts
cp .env.example .env
docker compose up -d postgres redis minio
pnpm --filter @platform/db migrate
pnpm --filter @platform/db seed   # solo en base vacía; idempotente
pnpm dev
```

Verificar:

```bash
curl -fsS http://localhost:4000/health/live
curl -fsS http://localhost:4000/health/ready | jq '.status'
```

Esperado: `live` responde `200`; `ready` responde `ok` con PostgreSQL/Redis/MinIO disponibles. Si el worker no está listo, `worker/health/ready` puede estar `degraded` y es una señal válida, no un fallo de demo.

## 2. Estado honesto (1 min)

Abrir `README.md` → tabla de fases. Mostrar:

- Fases 0–3, 5–7, 9, 10 y 12: completas con evidencia.
- Fases 4, 8, 11, 13–16: parciales y por qué.
- No decir “Fase 13 cerrada”: E2E es opt-in y `k6` no está en CI.

## 3. Aislamiento A/B (3 min)

Ejecutar la suite que crea datos espejo en dos tenants y verifica que A no ve B:

```bash
pnpm --filter @platform/api test src/fase13.isolation.test.ts
```

Esperado: PASS; incluye contexto de dos tenants, `x-tenant-id` rechazado y recursos tenant-scoped. Para RLS real de PostgreSQL, mostrar el job `integration` de CI o ejecutar `RUN_DB_INTEGRATION=1 pnpm --filter @platform/db test:integration` con PostgreSQL.

No usar `dev-login` contra la API persistente como demo: el `PersistentIdentityStore` no está cableado al camino de sesión user-bound (`platform_auth`/`withAuthTransaction`) y no se ha validado. El `dev-login` del store en memoria sigue siendo válido para tests unitarios.

## 4. RBAC (2 min)

```bash
pnpm --filter @platform/api test src/app.test.ts
```

Esperado: PASS; incluye operator sin `members:invite` (`403`) y auditor sin escritura. La UI puede ocultar el botón, pero la API es la autoridad.

## 5. Inventario stock 1 (2 min)

```bash
pnpm --filter @platform/api test src/inventory.concurrent.test.ts
```

Esperado: 50 requests concurrentes con stock 1 → exactamente 1 éxito (`201`) y 49 `409`; `available` final `0`.

## 6. Pago con muerte post-cobro (2 min)

```bash
pnpm --filter @platform/worker test src/payments.saga.test.ts
```

Esperado: el primer intento falla después de `charge`; el retry usa la misma `provider_key` y `chargeCalls` queda en 1. Aclarar: `FakePaymentProvider`; `StripePaymentProvider` tiene tests unitarios pero **no** se ha probado contra Stripe real.

## 7. Outbox, DLQ y trazas (2 min)

```bash
pnpm --filter @platform/worker test src/outbox.dedupe.test.ts src/relay/outboxRelay.test.ts
curl -s http://localhost:4000/metrics | grep -E 'outbox|payment_unknown|http_requests_total'
```

Esperado: dedupe por `jobId`/`processed_jobs`, backoff y DLQ. Mostrar `docs/runbooks/observability.md` para la correlación `x-request-id`/`traceparent` → audit/outbox/worker. No afirmar que todas las alertas están disparando.

## 8. Webhooks y SSRF (1 min)

```bash
pnpm --filter @platform/worker test src/webhook-egress.test.ts
```

Esperado: bloqueo de `127.0.0.1`, `169.254.169.254`, rangos privados, DNS con mezcla pública/privada y puertos no permitidos. Aclarar: DNS pinning implementado; **egress proxy pendiente**.

## 9. Cierre (1 min)

Mostrar `pnpm openapi:check` y `node scripts/check-docs-links.mjs`. Explicar que el gate construye la app y compara la tabla real de rutas con OpenAPI 3.1; el hash es solo recordatorio de cambio intencional.

## Claims que NO se hacen

- “Fase 13 cerrada” o “E2E completo en CI”: el job `e2e` es opt-in (`ENABLE_E2E=true`) y el `dev-login` de Playwright usa IDs del store en memoria, no los UUID del seed; no se presenta como verde.
- “Stripe en producción”: adapter implementado y testeado con mocks; sin sandbox/live.
- “KMS/Vault”: la clave de webhooks vive en entorno; rotación manual.
- “Egress proxy/allowlist”: solo DNS pinning + bloqueo de rangos.
- “Kubernetes/Terraform”: no hay manifests ni módulos en el árbol.
- “Backup automático”: hay comando y drill manual; no hay cron desplegado.
- “Métricas autenticadas en el API”: `/metrics` del API no tiene token; debe ir en red privada. El worker sí soporta `WORKER_METRICS_TOKEN`.
- “OpenAPI como verdad ejecutable”: `openapi:check` construye la app y falla si la tabla real de rutas, la seguridad o `Idempotency-Key` divergen del YAML; el hash solo recuerda cambios intencionales.

## Frases seguras

- “El aislamiento tiene tres capas: contexto autenticado, filtro de repository y RLS `FORCE`; los roles separan negocio, credenciales y relay.”
- “La saga evita el doble cobro con una clave determinista; el estado `unknown` es explícito y se reconcilia, no se asume fallo.”
- “La evidencia de CI cubre unit, integración y Docker; E2E y carga son opt-in y se declaran como tales.”
