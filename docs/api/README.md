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
