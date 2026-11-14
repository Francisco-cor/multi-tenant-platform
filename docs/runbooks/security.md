# Runbook — alertas de seguridad

- Owner: `platform-security`
- Última revisión: 2026-11-13
- Alertas relacionadas: `TenantIsolationViolation`, `MetricsScrapeDenied`, `WebhookEgressDenied`

## <a id="isolation"></a>Aislamiento tenant (`TenantIsolationViolation`)

**Severidad:** crítica. Cualquier indicio de lectura/escritura cross-tenant es SEV1.

1. Identificar `tenantHash`, ruta, `requestId`/`traceId` y usuario en los logs.
2. No reproducir con datos reales de otro tenant; usar IDs sintéticos.
3. Revisar la query y la transacción: `app.tenant_id`, `app.user_id`, `SET LOCAL ROLE` y filtro del repository.
4. Verificar la policy RLS y que el rol no sea `SUPERUSER`/`BYPASSRLS` (`assertRoleIsUnprivileged`).
5. Si hay exposición confirmada: contener el endpoint, preservar evidencia, rotar sesiones/API keys y escalar según `incident-response.md`.
6. Añadir prueba de regresión A/B y actualizar `docs/architecture/tenant-isolation.md`.

## <a id="metrics"></a>Scrape de métricas denegado (`MetricsScrapeDenied`)

**Severidad:** crítica si se debe a una exposición; warning si es un scrape mal configurado.

1. Confirmar qué endpoint se intentó (`/metrics` del API o del worker).
2. Recordar: el API **no** autentica `/metrics`; debe estar en red privada o detrás de un proxy con allowlist. El worker acepta `WORKER_METRICS_TOKEN`.
3. Revisar la configuración de Prometheus y la red; no abrir el puerto a Internet para “arreglar” el scrape.
4. Si hay exposición pública, tratarla como fuga de información: revisar logs de acceso, rotar tokens y aplicar allowlist.
5. Si el worker devuelve `401`, verificar `Authorization: Bearer <WORKER_METRICS_TOKEN>` en el scrape.

## <a id="webhook-egress"></a>Egress de webhook denegado (`WebhookEgressDenied`)

**Severidad:** warning; crítica si el destino es metadata/red interna.

1. Identificar endpoint, host, IP resuelta y `reason` (`private_blocked`, `invalid_port`, `dns_resolution_failed`, `invalid_url`).
2. Si es un falso positivo de un receptor legítimo, no desactivar el bloqueo: añadir el caso a revisión y usar un host público permitido.
3. Si hay intento de metadata/loopback, deshabilitar el endpoint y revisar quién lo creó (`webhook.created` en auditoría).
4. Revisar `webhook_egress_denials_total` y deliveries recientes.
5. Seguir `docs/runbooks/egress-ssrf.md` para contención y postmortem.

## Referencias

- `infra/prometheus/alerts.yml`
- `docs/threat-model.md`
- `docs/runbooks/egress-ssrf.md`
- `docs/runbooks/incident-response.md`
- `docs/security/exceptions.md`
