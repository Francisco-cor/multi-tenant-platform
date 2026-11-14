# Runbook — egress, SSRF y webhooks salientes

- Owner: `platform-security` + `platform-worker`
- Última revisión: 2026-11-13
- Cadencia: revisión trimestral y ante cualquier cambio de red/egress
- Estado: DNS pinning y bloqueo de rangos implementados; **egress proxy con allowlist pendiente**

## 1. Controles actuales

### Alta de endpoint

`validateUrl` (`apps/api/src/webhook-store.ts`) exige:

- `https://`, longitud <= 2048, sin `username`/`password`;
- host no bloqueado (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `169.254.169.254`, `metadata.google.internal`);
- IPv4 privada/loopback/link-local: `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `0/8`;
- IPv6 loopback, `fc00::/7`, `fe80::/10` y `::ffff:`.

### Salida (worker)

`apps/worker/src/webhook-egress.ts`:

1. Resuelve el hostname con DNS (`all: true`) antes de conectar.
2. Elige una IP pública; si todas son privadas, falla `webhook_egress_private_blocked`.
3. Fija la IP resuelta en la conexión HTTPS (evita DNS rebinding entre resolución y conexión).
4. Conserva el hostname original para SNI/Host.
5. Solo permite HTTPS en el puerto 443 por defecto; un puerto arbitrario se rechaza.
6. No sigue redirects (`fetchWebhook` usa `https.request`).
7. Timeouts: conexión 5 s, request 15 s; respuesta máxima 64 KiB.
8. Emite `webhook_egress_denials_total{reason}` y `WebhookEgressDenied`.

Rangos adicionales bloqueados en salida (`isForbiddenWebhookAddress`): `100.64/10`, `192.0.0/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, multicast/reservado (`>=224`), IPv6 `ff00::/8`, `2001:db8::/32`, NAT64 con IPv4 privada.

## 2. Gap residual

- No hay **egress proxy** ni allowlist de dominios en producción.
- No hay firewall de salida por namespace/pod; el worker puede intentar cualquier IP pública.
- No hay prueba automatizada contra un servidor DNS malicioso o rebinding en CI.
- No se inspeccionan respuestas TLS ni se aplica mTLS a receptores.

Mitigación temporal: ejecutar el worker en una red con salida restringida, usar un proxy HTTP corporativo si existe y monitorizar `WebhookEgressDenied`. Esto no sustituye el control de aplicación.

## 3. Verificación

```bash
# Un endpoint privado debe fallar al crear
curl -s -X POST http://localhost:4000/v1/webhooks/endpoints \
  -H 'host: acme.app.localhost' -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://169.254.169.254/latest/meta-data","events":["order.paid"]}' | jq
# -> 400 webhook_url_private_blocked

# Un host público se acepta; la salida se prueba en unit tests
pnpm --filter @platform/worker test src/webhook-egress.test.ts
```

La suite `apps/worker/src/webhook-egress.test.ts` cubre IPv4/IPv6 privadas, puertos no permitidos, DNS con mezcla pública/privada, redirects y límites de respuesta.

## 4. Incidente SSRF

1. **Contener:** deshabilitar el endpoint (`PATCH /v1/webhooks/endpoints/:id {status:"disabled"}`) o activar `kill_webhooks` si está disponible para el tenant.
2. **Preservar evidencia:** logs de `webhook_egress_denials_total`, `endpointId`, host, IP resuelta, timestamps; no borrar deliveries.
3. **Evaluar alcance:** ¿se alcanzó un servicio interno? ¿se enviaron datos? Revisar respuestas, tráfico de red y credenciales del worker.
4. **Rotar:** si hay sospecha de exposición, rotar secretos de webhook y credenciales del worker; ver `key-rotation.md`.
5. **Corregir:** añadir el rango/host al bloqueo o allowlist, desplegar y probar; si es un bug de resolución, añadir caso a `webhook-egress.test.ts`.
6. **Escalar:** SEV1/SEV2 según impacto; ver `incident-response.md`.
7. **Postmortem:** documentar causa, controles evadidos y acción para el egress proxy.

## 5. Checklist de producción

- [ ] Worker en subred con salida restringida.
- [ ] Egress proxy/allowlist implementado y probado.
- [ ] DNS pinning y bloqueo de rangos con tests en CI.
- [ ] Alerta `WebhookEgressDenied` con owner.
- [ ] Secretos de webhook cifrados y rotables (KMS pendiente).
- [ ] Revisión de logs sin PII ni secretos.

## 6. Referencias

- `apps/api/src/webhook-store.ts` — validación al crear/actualizar.
- `apps/worker/src/webhook-egress.ts` — resolución, pinning y límites.
- `apps/api/src/webhooks.test.ts`, `apps/worker/src/webhook-egress.test.ts`.
- `docs/threat-model.md`, `docs/runbooks/webhooks.md`.
