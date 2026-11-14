# Contratos API

El contrato inicial está en [`openapi.yaml`](./openapi.yaml). La API se versiona bajo `/v1` y usa errores con esta forma:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found",
    "requestId": "req_123"
  }
}
```

`requestId` debe aparecer también como header `x-request-id`. Los endpoints tenant-scoped deberán resolver el tenant desde host + identidad; no aceptarán `tenant_id` como autoridad del request.

## Estado y drift (2026-11-13)

`pnpm openapi:check` valida sintaxis, rutas mínimas y el hash de `docs/api/.openapi.hash`; no demuestra que cada ruta exista en el runtime. Drift conocido que debe corregir el pase de OpenAPI:

- `POST /v1/inventory/reserve` acepta `productId`; el YAML documenta `sku`.
- El YAML publica rutas no implementadas: `/v1/me`, `GET/POST /v1/organizations/{organizationId}/members`, `POST /v1/inventory/reservations` y `POST /v1/webhooks/{webhookId}/replay`.
- El runtime expone `/v1/auth/me`, `GET /v1/members`, `GET /v1/inventory/reservations` y `POST /v1/webhooks/deliveries/{deliveryId}/replay`.

Los archivos `POST /v1/files/presigned-upload` y su alias `POST /v1/files/presign` sí existen. No editar el YAML en el pase de documentación; el contrato pertenece al pase posterior de API/OpenAPI.
