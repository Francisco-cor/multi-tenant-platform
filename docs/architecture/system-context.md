# System context — baseline

```text
Usuario
  -> subdominio tenant
  -> Next.js web
  -> API Node.js versionada
       -> PostgreSQL: fuente de verdad y aislamiento RLS
       -> Redis: rate limiting, cache reconstruible y BullMQ
       -> S3-compatible: objetos, nunca autorización
       -> OIDC: identidad
       -> proveedores externos: pagos y webhooks
  -> OTel Collector -> métricas, traces y dashboards
```

En fase 0, PostgreSQL, Redis, MinIO, OTel, Prometheus y Grafana se levantan mediante Compose. Las apps se ejecutan desde el workspace para reducir el tiempo de feedback. Kubernetes y Terraform se incorporan después de estabilizar el comportamiento local.

## Límites

- Web no decide permisos: consume capacidades de API.
- API resuelve request context y aplica policies.
- DB protege datos tenant-scoped con filtro de repository y RLS.
- Worker ejecuta efectos asíncronos, pero no inventa un tenant: todo job tenant-scoped transporta tenant ID y correlation ID.
- Storage guarda bytes; metadata, autorización y auditoría viven en la plataforma.
