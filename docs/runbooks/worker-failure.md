# Runbook — fallo y reinicio de worker

- Owner: `platform-worker`
- Última revisión: 2026-11-13
- Señales: `WorkerDown`, `OutboxLag`, `DLQNonEmpty`, readiness `degraded`, jobs atascados con lease vencido

## 1. Diagnóstico rápido

```bash
curl -s http://localhost:4010/health/live | jq
curl -s http://localhost:4010/health/ready | jq
```

`/health/ready` del worker comprueba:

- DB y consumidores;
- relay, scheduler y heartbeat (edad máxima);
- workers BullMQ configurados vs running;
- `outboxLagSeconds`, `outboxPending`, `dlqSize`, `dlqOldestAgeSeconds`.

Si `redis: fail`, el relay no puede publicar; la API sigue escribiendo en outbox. Si `workersRunning < workersConfigured`, falta un consumidor o un worker murió.

## 2. Workers caídos

1. Revisar logs `worker_bootstrap_failed`, `outbox_relay_error`, `worker_shutdown_started/completed`.
2. Confirmar Redis y DB (`docker compose ps`, `redis-cli ping`, `SELECT 1`).
3. Reiniciar el proceso; el relay reclamará outbox pendiente con `SKIP LOCKED`.
4. Verificar que `outboxPending` baja y `outboxLagSeconds` vuelve a <30 s.
5. Si el reinicio no basta, revisar leases vencidos y jobs atascados.

## 3. Job atascado

1. Identificar `jobId`, cola y `tenantHash` en logs.
2. Revisar `processed_jobs` y `dlq_jobs` para ese `jobId`; un lease vencido debe permitir reintento.
3. No borrar manualmente `processed_jobs` salvo procedimiento de replay de DLQ (`dlq-replay.md`).
4. Si el handler tiene un bug, pausar la cola, corregir y desplegar; luego replay controlado.

## 4. SIGTERM / deploy

El worker hace graceful shutdown: deja de aceptar jobs, espera los activos, cierra relay y colas con deadline de 30 s. Un job no confirmado queda pendiente o con lease; se recupera al reiniciar.

Comprobar:

```bash
docker compose logs --tail=100 worker | grep -E 'shutdown|relay|error'
```

## 5. Outbox y DLQ

- `outbox_lag_seconds > 30` → revisar relay/Redis; ver `dlq-replay.md`.
- `dlq_size > 0` → inspeccionar causa; corregir y replay auditado.
- `payment_unknown` → ver `payment-unknown.md`; no liberar reservas ni recobrar sin reconciliación.

## 6. Evidencia

- [ ] Hora de caída y recuperación.
- [ ] `health/ready` antes/después.
- [ ] `outboxPending`/`outboxLagSeconds` antes/después.
- [ ] Jobs recuperados y DLQ resultante.
- [ ] Causa y acción preventiva.

## 7. Referencias

- `apps/worker/src/main.ts`, `readiness.ts`, `scheduler.ts`, `lifecycle.ts`.
- `docs/runbooks/dlq-replay.md`, `docs/runbooks/observability.md`.
- `docs/failure-scenarios/worker-restart.md`.
