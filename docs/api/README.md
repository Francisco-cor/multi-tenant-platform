# Contratos API

El contrato ejecutable está en [`openapi.yaml`](./openapi.yaml). La API se versiona bajo `/v1` y usa errores con esta forma:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found",
    "requestId": "req_123"
  }
}
```

`requestId` aparece también como header `x-request-id`. Los endpoints tenant-scoped resuelven el tenant desde host + identidad; no aceptan `tenant_id` como autoridad del request.

## Autenticación

- `cookieAuth`: cookie `platform_session` (sesión web). Las mutaciones desde navegador requieren `X-CSRF-Token` y un `Origin` permitido.
- `bearerAuth`: `Authorization: Bearer <token>` con el mismo token de sesión.
- `apiKeyAuth`: `X-Api-Key: pk_...`; las rutas que la aceptan comprueban los scopes permitidos para la operación.
- `webhookHmac`: `X-Webhook-Timestamp` + `X-Webhook-Signature: v1,<hex>` sobre `${timestamp}.${rawBody}`; Stripe usa `Stripe-Signature`.

Cada operación protegida documenta `401` y `403`. `POST /v1/orders` exige `Idempotency-Key` (16..255 caracteres URL-safe) y documenta el replay con `idempotent-replayed: true` y el conflicto 409.

## Gate de conformidad

`pnpm openapi:check` ya no es un chequeo de hash:

1. construye `buildApp()` con adaptadores en memoria y obtiene la tabla real de rutas Fastify;
2. normaliza `:param` a `{param}` y falla si hay rutas o métodos en un solo lado;
3. valida OpenAPI 3.1: `operationId` únicos, tags, descripciones, referencias resueltas y cero `nullable`;
4. exige los cuatro esquemas de seguridad, `401`/`403` en operaciones protegidas e `Idempotency-Key` requerido en `POST /v1/orders`;
5. imprime el hash de [`openapi.yaml`](./openapi.yaml) si cambia. El archivo [`.openapi.hash`](./.openapi.hash) es solo un recordatorio de cambio intencional; no sustituye la comparación de rutas.

Casos del gate: `node --test scripts/check-openapi.test.mjs`. La comparación también corre en `pnpm --filter @platform/api test`, que falla ante cualquier drift entre la especificación y el runtime.

## Cobertura actual

Las 65 operaciones implementadas (56 paths) están documentadas exactamente una vez. El contrato cubre health/readiness/startup, `metrics`, auth OIDC/dev-login/sesiones, organizaciones, contexto, branches, members e invitaciones, inventario y reservas, órdenes/pagos, webhooks de pago y genéricos, endpoints/deliveries/replay, API keys, automatizaciones, archivos, DLQ (incluidos alias `/v1/admin/dlq`), flags y auditoría.

Cualquier cambio de ruta o método en `apps/api/src/app.ts` debe actualizar el YAML en el mismo commit; el gate falla en caso contrario.
